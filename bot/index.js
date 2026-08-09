// The Cognition bot process.
//
// It holds the gateway connection and does two things: route interactions
// through the Dispatcher, and fire due schedules. It contains no knowledge of
// tickets, panels, or any other system in the server — all of that lives in the
// Registry, which is the point.
//
// Run it with `npm run bot`. It needs to stay running for buttons to respond;
// Classifer keeps working without it.

import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { requireEnv, TOKEN, GUILD_ID } from '../shared/env.js';
import { getDb } from '../shared/store.js';
import { log as auditLog } from '../shared/audit.js';
import { listSchedules } from '../shared/registry.js';
import { attach } from './dispatcher.js';
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
});

attach(client);

let stopScheduler = () => {};

client.once(Events.ClientReady, async (ready) => {
  const guild = ready.guilds.cache.get(GUILD_ID);
  console.error(`[cognition] ready as ${ready.user.tag}`);
  console.error(`[cognition] guild: ${guild ? guild.name : `NOT IN GUILD ${GUILD_ID}`}`);

  const schedules = listSchedules({ enabledOnly: true });
  console.error(`[cognition] ${schedules.length} enabled schedule(s)`);

  ready.user.setPresence({
    status: 'online',
    activities: [{ name: 'the Registry', type: ActivityType.Watching }],
  });

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
