// Laying out the server.
//
// Idempotent by construction: it reads what exists, creates only what is
// missing, and reports the difference. Running it twice is a no-op, which means
// it is safe to run when unsure whether it has been run.

import { tool, z } from '../kit.js';
import { post, patch, put, fetchChannels, fetchRoles, guildRoute, CHANNEL_TYPE, permBits } from '../../../shared/rest.js';
import { GUILD_ID } from '../../../shared/env.js';
import { setSetting, getSetting } from '../../../shared/store.js';
import { LOG_CHANNEL_SETTING } from '../../../shared/audit.js';
import { SESSIONS_CHANNEL_SETTING, SANDBOX_CATEGORY_SETTING } from './session.js';

export const OPERATOR_ROLE_SETTING = 'operator_role_id';

// Read-only for everyone: the two Command channels are a record, not a chat.
// Cognition itself posts through the bot account, which Administrator exempts
// from these denies.
const READ_ONLY = [
  { id: GUILD_ID, type: 0, allow: permBits(['ViewChannel', 'ReadMessageHistory']), deny: permBits(['SendMessages', 'AddReactions', 'CreatePublicThreads']) },
];

tool({
  name: 'server_bootstrap',
  title: 'Build the Command and Sandbox layout',
  description:
    'Create the Command category (#command-log, #active-sessions), the Sandbox category, and the Operator role — whichever of them do not already exist — and wire the Registry settings that point at them. Safe to run repeatedly; the second run reports no changes.',
  mutating: true,
  schema: {
    dry_run: z.boolean().default(false).optional().describe('report what would change without changing it'),
  },
  async run({ dry_run = false }) {
    const channels = await fetchChannels();
    const roles = await fetchRoles();
    const changes = [];
    const kept = [];

    const findCategory = (name) =>
      channels.find((c) => c.type === CHANNEL_TYPE.category && c.name.toLowerCase() === name.toLowerCase());
    const findChannel = (name, parentId) =>
      channels.find((c) => c.type !== CHANNEL_TYPE.category && c.name.toLowerCase() === name.toLowerCase() && (!parentId || c.parent_id === parentId));

    // ---- Command category ----
    let command = findCategory('Command');
    if (!command) {
      if (dry_run) {
        changes.push('would create category "Command"');
        command = { id: '(pending)' };
      } else {
        command = await post(guildRoute('/channels'), { name: 'Command', type: CHANNEL_TYPE.category, position: 0 }, { reason: 'Cognition bootstrap' });
        changes.push(`created category "Command" (${command.id})`);
      }
    } else {
      kept.push(`category "Command" (${command.id})`);
    }

    // ---- #command-log ----
    let commandLog = findChannel('command-log');
    if (!commandLog) {
      if (dry_run) changes.push('would create #command-log');
      else {
        commandLog = await post(
          guildRoute('/channels'),
          {
            name: 'command-log',
            type: CHANNEL_TYPE.text,
            parent_id: command.id,
            topic: 'Every action Cognition takes. Written by the system, not by people.',
            permission_overwrites: READ_ONLY,
          },
          { reason: 'Cognition bootstrap' },
        );
        changes.push(`created #command-log (${commandLog.id})`);
      }
    } else {
      kept.push(`#command-log (${commandLog.id})`);
    }
    if (commandLog && !dry_run && getSetting(LOG_CHANNEL_SETTING) !== commandLog.id) {
      setSetting(LOG_CHANNEL_SETTING, commandLog.id);
      changes.push(`audit embeds now go to #command-log (${commandLog.id})`);
    }

    // ---- #active-sessions ----
    let activeSessions = findChannel('active-sessions');
    if (!activeSessions) {
      if (dry_run) changes.push('would create #active-sessions');
      else {
        activeSessions = await post(
          guildRoute('/channels'),
          {
            name: 'active-sessions',
            type: CHANNEL_TYPE.text,
            parent_id: command.id,
            topic: 'One thread per running experiment. Started and updated by Cognition.',
            permission_overwrites: READ_ONLY,
          },
          { reason: 'Cognition bootstrap' },
        );
        changes.push(`created #active-sessions (${activeSessions.id})`);
      }
    } else {
      kept.push(`#active-sessions (${activeSessions.id})`);
    }
    if (activeSessions && !dry_run && getSetting(SESSIONS_CHANNEL_SETTING) !== activeSessions.id) {
      setSetting(SESSIONS_CHANNEL_SETTING, activeSessions.id);
      changes.push(`session threads now go to #active-sessions (${activeSessions.id})`);
    }

    // ---- Sandbox category ----
    let sandbox = findCategory('Sandbox');
    if (!sandbox) {
      if (dry_run) changes.push('would create category "Sandbox"');
      else {
        sandbox = await post(guildRoute('/channels'), { name: 'Sandbox', type: CHANNEL_TYPE.category, position: 1 }, { reason: 'Cognition bootstrap' });
        changes.push(`created category "Sandbox" (${sandbox.id})`);
      }
    } else {
      kept.push(`category "Sandbox" (${sandbox.id})`);
    }
    if (sandbox && !dry_run && getSetting(SANDBOX_CATEGORY_SETTING) !== sandbox.id) {
      setSetting(SANDBOX_CATEGORY_SETTING, sandbox.id);
    }

    // ---- Operator role ----
    let operator = roles.find((r) => r.name.toLowerCase() === 'operator');
    if (!operator) {
      if (dry_run) changes.push('would create role @Operator');
      else {
        operator = await post(
          guildRoute('/roles'),
          { name: 'Operator', permissions: permBits([]), color: 0x5865f2, hoist: true, mentionable: true },
          { reason: 'Cognition bootstrap' },
        );
        changes.push(`created role @Operator (${operator.id})`);
      }
    } else {
      kept.push(`role @Operator (${operator.id})`);
    }
    if (operator && !dry_run && getSetting(OPERATOR_ROLE_SETTING) !== operator.id) {
      setSetting(OPERATOR_ROLE_SETTING, operator.id);
    }

    const summary = [
      dry_run ? 'DRY RUN — nothing was changed.' : changes.length ? 'Bootstrap applied.' : 'No changes — already bootstrapped.',
      '',
      changes.length ? `CHANGES\n${changes.map((c) => `  ${c}`).join('\n')}` : 'CHANGES\n  (none)',
      '',
      kept.length ? `ALREADY PRESENT\n${kept.map((k) => `  ${k}`).join('\n')}` : '',
      '',
      'SETTINGS',
      `  command log      ${getSetting(LOG_CHANNEL_SETTING) ?? '(unset)'}`,
      `  active sessions  ${getSetting(SESSIONS_CHANNEL_SETTING) ?? '(unset)'}`,
      `  sandbox category ${getSetting(SANDBOX_CATEGORY_SETTING) ?? '(unset)'}`,
      `  operator role    ${getSetting(OPERATOR_ROLE_SETTING) ?? '(unset)'}`,
    ]
      .filter((l) => l !== '')
      .join('\n');

    return { target: GUILD_ID, text: summary, skipPublish: dry_run };
  },
});

tool({
  name: 'settings_get',
  title: 'Read the wiring',
  description: 'The ids Cognition has been told to use for the log channel, the sessions channel, the sandbox category and the Operator role.',
  schema: {},
  async run() {
    return [
      `command log channel   ${getSetting(LOG_CHANNEL_SETTING) ?? '(unset)'}`,
      `active sessions       ${getSetting(SESSIONS_CHANNEL_SETTING) ?? '(unset)'}`,
      `sandbox category      ${getSetting(SANDBOX_CATEGORY_SETTING) ?? '(unset)'}`,
      `operator role         ${getSetting(OPERATOR_ROLE_SETTING) ?? '(unset)'}`,
      `guild                 ${GUILD_ID}`,
    ].join('\n');
  },
});

tool({
  name: 'settings_set',
  title: 'Point Cognition at a channel or role',
  description: 'Override one of the wiring ids by hand — useful if a channel was recreated and the stored id is stale.',
  mutating: true,
  schema: {
    key: z.enum([
      'command_log_channel_id',
      'active_sessions_channel_id',
      'sandbox_category_id',
      'operator_role_id',
      'delegated_user_id',
      'delegated_scope',
      'delegated_at',
      'delegated_note',
    ]),
    value: z.string(),
  },
  async run({ key, value }) {
    setSetting(key, value);
    return { target: value, text: `${key} = ${value}` };
  },
});
