// The Cognition bot process.
//
// It holds the gateway connection and does two things: route interactions
// through the Dispatcher, and fire due schedules. It contains no knowledge of
// tickets, panels, or any other system in the server — all of that lives in the
// Registry, which is the point.
//
// Run it with `npm run bot`. It needs to stay running for buttons to respond;
// Classifer keeps working without it.

import { Client, GatewayIntentBits, Events, ActivityType, Partials } from 'discord.js';
import { requireEnv, TOKEN, GUILD_ID } from '../shared/env.js';
import { getDb, setSetting } from '../shared/store.js';
import { log as auditLog } from '../shared/audit.js';
import { engineHash } from '../shared/version.js';
import { listSchedules, getAction } from '../shared/registry.js';
import { execute, systemContext, setPresenceSink } from '../shared/executor.js';
import { listTriggers } from '../shared/triggers.js';
import { attach } from './dispatcher.js';
import { attach as attachEvents } from './events.js';
import { start as startScheduler } from './scheduler.js';

requireEnv();
getDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildIntegrations,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
});

attach(client);
attachEvents(client);

// Hand the executor the one capability it cannot reach over REST. A custom
// status is the odd one out in the gateway's own encoding: the text travels in
// `state` and the name is ignored, so it is translated here rather than leaking
// that detail into every Registry row that sets one.
setPresenceSink(({ activities, status }) => {
  if (!client.user) throw new Error('the gateway is not ready yet');
  client.user.setPresence({
    status,
    activities: activities.map(({ type, text, url }) =>
      type === 4 ? { name: 'Custom Status', type: 4, state: text } : { name: text, type, url },
    ),
  });
});

let stopScheduler = () => {};

client.once(Events.ClientReady, async (ready) => {
  const guild = ready.guilds.cache.get(GUILD_ID);
  console.error(`[cognition] ready as ${ready.user.tag}`);
  console.error(`[cognition] guild: ${guild ? guild.name : `NOT IN GUILD ${GUILD_ID}`}`);

  const schedules = listSchedules({ enabledOnly: true });
  const triggers = listTriggers({ enabledOnly: true });
  console.error(`[cognition] ${schedules.length} enabled schedule(s), ${triggers.length} enabled trigger(s)`);

  // Record which build of the engine this process actually loaded. Node caches
  // modules at import, so from here on this process runs THIS code no matter
  // what changes on disk — and system_status needs to be able to say so.
  const build = engineHash();
  setSetting('bot_engine_hash', build);
  setSetting('bot_started_at', new Date().toISOString());
  console.error(`[cognition] engine build ${build}`);

  // The status is behaviour like any other, so it is a row: if presence.boot
  // exists it decides what the bot appears to be doing, and editing that row
  // changes the status on the next run of it — no edit here, no restart.
  if (getAction('presence.boot')) {
    await execute('presence.boot', systemContext()).catch((e) =>
      console.error(`[cognition] presence.boot failed: ${e.message}`),
    );
    // What the gateway kept, not what we asked for. Discord silently drops
    // activities a bot may not use, and without this the difference is
    // invisible from here.
    console.error(
      `[cognition] presence: ${JSON.stringify(
        (ready.user.presence?.activities ?? []).map((a) => ({ name: a.name, type: a.type, url: a.url })),
      )}`,
    );
  } else {
    ready.user.setPresence({
      status: 'online',
      activities: [{ name: 'the Registry', type: ActivityType.Watching }],
    });
  }

  stopScheduler = startScheduler();

  auditLog({
    source: 'dispatcher',
    actor: 'system',
    op: 'bot_online',
    target: ready.user.id,
    result: 'ok',
    detail: `${schedules.length} schedule(s) armed`,
  });
});

client.on(Events.Error, (e) => console.error(`[cognition] client error: ${e.message}`));
client.on(Events.ShardDisconnect, (_, id) => console.error(`[cognition] shard ${id} disconnected`));
client.on(Events.ShardReconnecting, (id) => console.error(`[cognition] shard ${id} reconnecting`));

async function shutdown(signal) {
  console.error(`[cognition] ${signal} — shutting down`);
  stopScheduler();
  try {
    auditLog({ source: 'dispatcher', actor: 'system', op: 'bot_offline', result: 'ok', detail: signal });
    // Give the audit embed a moment to reach Discord before the socket closes.
    await new Promise((r) => setTimeout(r, 400));
  } catch {
    /* going down anyway */
  }
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error(`[cognition] unhandled rejection: ${e?.message ?? e}`));

await client.login(TOKEN);
