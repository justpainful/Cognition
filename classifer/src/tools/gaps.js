// Tools for the things that were only discoverable by running the system:
// keeping the Registry honest about what is actually on Discord, and being able
// to carry behaviour out of the database and back in.

import { tool, z, table, json } from '../kit.js';
import { get, fetchChannels, fetchRoles, guildRoute } from '../../../shared/rest.js';
import { GUILD_ID } from '../../../shared/env.js';
import {
  listSessions,
  listActions,
  listComponents,
  listSchedules,
  putAction,
  putComponent,
  putSchedule,
  getAction,
} from '../../../shared/registry.js';
import { listTriggers, putTrigger, listCounters } from '../../../shared/triggers.js';

tool({
  name: 'drift_check',
  title: 'Where the Registry and Discord disagree',
  description:
    'Compares what the Registry believes exists against what is actually on the server. Anyone with Manage Channels can rename or delete things by hand, and nothing stops them — this is how that shows up rather than surfacing later as a button that fails.',
  schema: {},
  async run() {
    const [channels, roles] = await Promise.all([fetchChannels(), fetchRoles()]);
    const channelIds = new Set(channels.map((c) => c.id));
    const roleIds = new Set(roles.map((r) => r.id));
    const byId = Object.fromEntries(channels.map((c) => [c.id, c]));

    const problems = [];

    for (const s of listSessions()) {
      if (['closed', 'archived'].includes(s.state)) continue;
      if (s.categoryId && !channelIds.has(s.categoryId)) {
        problems.push(`session #${s.id} "${s.name}": category ${s.categoryId} no longer exists`);
      }
      for (const c of s.channels) {
        if (!channelIds.has(c.id)) {
          problems.push(`session #${s.id} "${s.name}": channel #${c.name} (${c.id}) no longer exists`);
        } else if (byId[c.id].name !== c.name) {
          problems.push(
            `session #${s.id} "${s.name}": #${c.name} was renamed to #${byId[c.id].name} outside the system`,
          );
        }
      }
    }

    // A component pointing at a missing action is a dead button; an action
    // naming a missing role or channel fails only when somebody presses it.
    const actions = listActions();
    const actionKeys = new Set(actions.map((a) => a.key));
    for (const c of listComponents()) {
      if (!actionKeys.has(c.actionKey)) {
        problems.push(`component ${c.key} ("${c.spec.label ?? ''}") points at missing action "${c.actionKey}"`);
      }
    }

    for (const a of actions) {
      const blob = JSON.stringify({ params: a.params, requires: a.requires });
      for (const id of blob.match(/\b\d{17,20}\b/g) ?? []) {
        if (id === GUILD_ID) continue;
        if (!channelIds.has(id) && !roleIds.has(id)) {
          problems.push(`action "${a.key}" references ${id}, which is neither a live channel nor a live role`);
        }
      }
    }

    for (const t of listTriggers()) {
      if (!actionKeys.has(t.actionKey)) {
        problems.push(`trigger "${t.key}" points at missing action "${t.actionKey}"`);
      }
    }
    for (const s of listSchedules()) {
      if (!actionKeys.has(s.actionKey)) {
        problems.push(`schedule "${s.key}" points at missing action "${s.actionKey}"`);
      }
    }

    if (!problems.length) {
      return 'No drift. Every session, component, trigger and schedule points at something that exists.';
    }
    return [`${problems.length} discrepancy(ies):`, '', ...problems.map((p) => `  ${p}`)].join('\n');
  },
});

tool({
  name: 'registry_export',
  title: 'Export all behaviour as JSON',
  description:
    'Every action, component, trigger and schedule in one document. This is the backup for behaviour: the database file holds it, but nothing else does, and a Registry lost is every system in the server lost. Also the way to move a system to another guild.',
  schema: {
    include_components: z.boolean().default(true).optional().describe('components carry guild-specific ids'),
  },
  async run({ include_components = true }) {
    const doc = {
      exported_at: new Date().toISOString(),
      guild_id: GUILD_ID,
      actions: listActions().map((a) => ({
        key: a.key,
        kind: a.kind,
        params: a.params,
        requires: a.requires,
        confirm: a.confirm,
        note: a.note,
      })),
      triggers: listTriggers().map((t) => ({
        key: t.key,
        event: t.event,
        filter: t.filter,
        action_key: t.actionKey,
        enabled: t.enabled,
        note: t.note,
      })),
      schedules: listSchedules().map((s) => ({
        key: s.key,
        cron: s.cron,
        action_key: s.actionKey,
        context: s.context,
        enabled: s.enabled,
        note: s.note,
      })),
      counters: listCounters().map((c) => ({ key: c.key, value: c.value })),
    };
    if (include_components) {
      doc.components = listComponents().map((c) => ({
        key: c.key,
        kind: c.kind,
        action_key: c.actionKey,
        spec: c.spec,
        session_id: c.sessionId,
      }));
    }

    return {
      target: GUILD_ID,
      skipPublish: true,
      text: [
        `${doc.actions.length} actions · ${doc.triggers.length} triggers · ${doc.schedules.length} schedules` +
          (doc.components ? ` · ${doc.components.length} components` : ''),
        '',
        json(doc),
      ].join('\n'),
    };
  },
});

tool({
  name: 'registry_import',
  title: 'Load behaviour from an export',
  description:
    'Write actions, triggers and schedules back from a registry_export document. Existing keys are overwritten. Component keys are preserved when present, because a live button in a posted panel refers to its key and would otherwise be orphaned.',
  mutating: true,
  schema: {
    document: z.record(z.string(), z.any()).describe('a registry_export document'),
    dry_run: z.boolean().default(true).optional().describe('report what would be written without writing it'),
  },
  async run({ document, dry_run = true }) {
    const planned = [];
    const problems = [];

    for (const a of document.actions ?? []) {
      planned.push(`action ${a.key} (${a.kind})`);
      if (!dry_run) {
        try {
          putAction({ key: a.key, kind: a.kind, params: a.params, requires: a.requires, confirm: a.confirm, note: a.note });
        } catch (e) {
          problems.push(`action ${a.key}: ${e.message}`);
        }
      }
    }

    // Actions land first, because everything below points at one.
    for (const c of document.components ?? []) {
      planned.push(`component ${c.key} -> ${c.action_key}`);
      if (!dry_run) {
        try {
          putComponent({ key: c.key, kind: c.kind, actionKey: c.action_key, spec: c.spec, sessionId: c.session_id ?? null });
        } catch (e) {
          problems.push(`component ${c.key}: ${e.message}`);
        }
      }
    }
    for (const t of document.triggers ?? []) {
      planned.push(`trigger ${t.key} on ${t.event}`);
      if (!dry_run) {
        try {
          putTrigger({ key: t.key, event: t.event, filter: t.filter, actionKey: t.action_key, enabled: t.enabled, note: t.note });
        } catch (e) {
          problems.push(`trigger ${t.key}: ${e.message}`);
        }
      }
    }
    for (const s of document.schedules ?? []) {
      planned.push(`schedule ${s.key} (${s.cron})`);
      if (!dry_run) {
        try {
          putSchedule({ key: s.key, cron: s.cron, actionKey: s.action_key, context: s.context, enabled: s.enabled, note: s.note });
        } catch (e) {
          problems.push(`schedule ${s.key}: ${e.message}`);
        }
      }
    }

    return {
      target: GUILD_ID,
      text: [
        dry_run ? `DRY RUN — nothing written. ${planned.length} entries would be:` : `Imported ${planned.length} entries:`,
        ...planned.map((p) => `  ${p}`),
        problems.length ? `\nFAILED:\n${problems.map((p) => `  ${p}`).join('\n')}` : '',
        document.guild_id && document.guild_id !== GUILD_ID
          ? `\nNote: this document came from guild ${document.guild_id}. Any channel or role id inside it points at that server, not this one — run drift_check afterwards.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

tool({
  name: 'invites_list',
  title: 'List active invites',
  description:
    'Every invite to this guild with who made it, how often it has been used and when it expires. The membership of a server is only as bounded as its invites, and nothing else here reports them.',
  schema: {},
  async run() {
    const invites = await get(guildRoute('/invites'));
    if (!invites.length) return 'No active invites. The only way in is a new one.';
    return table(invites, [
      { header: 'code', get: (i) => i.code },
      { header: 'channel', get: (i) => i.channel?.name ?? i.channel_id },
      { header: 'by', get: (i) => i.inviter?.username ?? '?' },
      { header: 'uses', get: (i) => `${i.uses}${i.max_uses ? `/${i.max_uses}` : ''}` },
      { header: 'expires', get: (i) => i.expires_at?.slice(0, 16).replace('T', ' ') ?? 'never' },
    ]);
  },
});
