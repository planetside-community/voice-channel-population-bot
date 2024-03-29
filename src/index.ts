/**
 * Welcome to Cloudflare Workers! This is your first scheduled worker.
 *
 * - Run `wrangler dev --local` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/cdn-cgi/mf/scheduled"` to trigger the scheduled event
 * - Go back to the console to see what your worker has logged
 * - Update the Cron trigger in wrangler.toml (see https://developers.cloudflare.com/workers/wrangler/configuration/#triggers)
 * - Run `wrangler publish --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/runtime-apis/scheduled-event/
 */

import {
  getPlatformConfig,
  serverMappings,
  updateTimeMappings,
} from "./config";
import { updateChannelName } from "./discord";
import { getMetagame } from "./metagame";
import { getAllPopulations } from "./population";
import { serverListingContinents, serverListingPopulation } from "./strings";
import { QueueMessage } from "./types";

export interface Env {
  SERVICE_ID: string;
  BOT_TOKEN: string;
  PUSH_KEY: string;

  CONFIG: KVNamespace;
  STREAM: Queue<QueueMessage>;
}

const runChannelNameUpdate = async (env: Env, onlyUpdate?: string[]) => {
  const [populations, metagame] = await Promise.all([
    getAllPopulations(),
    getMetagame(),
  ]);

  for (const [serverID, channelIDs] of Object.entries(serverMappings)) {
    const metagameWorld = metagame.find((m) => m.id === +serverID);
    if (!metagameWorld) {
      console.log("No metagame world entry found for", serverID);
      continue;
    }

    const popListing = serverListingPopulation(
      serverID,
      populations.find((p) => p.id === +serverID)?.average || 0
    );
    const contListing = serverListingContinents(metagameWorld);

    console.log("Sending", { popListing, contListing });

    // Update the server listings
    for (const [popChannel, contChannel] of channelIDs) {
      const shouldUpdatePop = !onlyUpdate || onlyUpdate.includes(popChannel);
      const shouldUpdateCont = !onlyUpdate || onlyUpdate.includes(contChannel);

      shouldUpdatePop &&
        env.STREAM.send({
          event: "channel_name_update",
          channel_id: popChannel,
          channel_name: popListing,
        }).then(() =>
          console.log("Sent to queue =>", { popChannel, popListing })
        );

      if (contChannel) {
        shouldUpdateCont &&
          env.STREAM.send({
            event: "channel_name_update",
            channel_id: contChannel,
            channel_name: contListing,
          }).then(() =>
            console.log("Sent to queue =>", { contChannel, contListing })
          );
      }
    }
  }

  await doUpdateTime(env);
};

const doUpdateTime = async (env: Env) => {
  // Send update time
  const humanDate = new Date().toLocaleString("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const updateTimeText = `@ ${humanDate} UTC`;

  for (const channelID of updateTimeMappings) {
    await env.STREAM.send({
      event: "channel_name_update",
      channel_id: channelID,
      channel_name: updateTimeText,
    }).then(() =>
      console.log("Sent to queue =>", { channelID, updateTimeText })
    );
  }
};

const runInteractions = async (env: Env) => {};

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await Promise.all([runChannelNameUpdate(env), runInteractions(env)]);
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const { body } of batch.messages) {
      if (body.event === "channel_name_update") {
        try {
          await updateChannelName(
            env.BOT_TOKEN,
            body.channel_id,
            body.channel_name
          );
        } catch (e) {
          console.error("channel_name_update FAILED => ", { body, e });
        }
      }
    }
  },
  async fetch(request: Request, env: Env, ctx: FetchEvent): Promise<Response> {
    if (env.PUSH_KEY && request.url.includes(env.PUSH_KEY)) {
      const onlyUpdate =
        new URL(request.url).searchParams.getAll("channels") || undefined;
      ctx.waitUntil(runChannelNameUpdate(env, onlyUpdate));
      return new Response("ok");
    } else {
      const parts = request.url.split("/");
      const serverID = parts[parts.length - 1];
      const platformConfig = getPlatformConfig(serverID);

      if (request.url.includes("/x/debug-population")) {
        const population = await getAllPopulations();
        return new Response(JSON.stringify(population));
      }

      if (request.url.includes("/x/debug-messages")) {
        const [populations, metagame] = await Promise.all([
          getAllPopulations(),
          getMetagame(),
        ]);

        const worlds = [1, 10, 13, 17, 19, 40, 1000, 2000];

        return new Response(
          JSON.stringify(
            worlds.map((id) => {
              const metagameWorld = metagame.find((m) => m.id === id);
              const contListing = metagameWorld
                ? serverListingContinents(metagameWorld)
                : "METAGAME_FAILED";
              const popListing = serverListingPopulation(
                String(id),
                populations.find((p) => p.id === id)?.average || 0
              );
              return {
                id,
                popListing,
                contListing,
              };
            })
          )
        );
      }

      if (request.url.includes("/x/bump-update-time")) {
        await doUpdateTime(env);
        return new Response("ok");
      }

      // if (request.url.includes("/x/test-message")) {
      //   await upsertMessage(
      //     env.BOT_TOKEN,
      //     "997704124416151622",
      //     "998448233481240606",
      //     serverStatsEmbed(await getAllPopulations())
      //   );
      //   return new Response("ok");
      // }

      return new Response("not ok", { status: 400 });
    }
  },
};
