// Reading and writing the Registry — which is to say, writing behaviour.
//
// A new feature is a row here, not a commit. Adding a button, changing what an
// existing button does, restricting who may press it: all of it lands the moment
// the row is written, because the Dispatcher reads the Registry on every single
// interaction and caches nothing.

import { tool, z, table, json } from '../kit.js';
import {
  ACTION_KINDS,
  DESTRUCTIVE_KINDS,
  getAction,
  listActions,
  putAction,
  deleteAction,
  getComponent,
  listComponents,
  putComponent,
  deleteComponent,
} from '../../../shared/registry.js';

tool({
  name: 'registry_list',
  title: 'List Registry contents',
  description: 'Every action and component currently defined. Start here before adding something that may already exist.',
  schema: {
    kind: z.enum(['actions', 'components', 'both']).default('both'),
  },
  async run({ kind = 'both' }) {
    const out = [];
    if (kind !== 'components') {
      const actions = listActions();
      out.push(`ACTIONS (${actions.length})`);
      out.push(
        actions.length
          ? table(actions, [
              { header: 'key', get: (a) => a.key },
              { header: 'kind', get: (a) => a.kind },
              { header: 'confirm', get: (a) => (a.confirm ? 'yes' : '') },
              { header: 'requires', get: (a) => (a.requires ? a.requires.type : '') },
              { header: 'note', get: (a) => (a.note ?? '').slice(0, 40) },
            ])
          : '(none)',
      );
    }
    if (kind !== 'actions') {
      const comps = listComponents();
      out.push('', `COMPONENTS (${comps.length})`);
      out.push(
        comps.length
          ? table(comps, [
              { header: 'key', get: (c) => c.key },
              { header: 'label', get: (c) => c.spec.label ?? '' },
              { header: 'action', get: (c) => c.actionKey },
              { header: 'session', get: (c) => c.sessionId ?? '' },
            ])
          : '(none)',
      );
    }
    return out.join('\n');
  },
});

tool({
  name: 'registry_get',
  title: 'Read one Registry entry',
  description: 'The full definition of one action or component, including its params, requires clause and confirm flag.',
  schema: {
    key: z.string(),
    kind: z.enum(['action', 'component']).default('action'),
  },
  async run({ key, kind = 'action' }) {
    const entry = kind === 'action' ? getAction(key) : getComponent(key);
    if (!entry) return `No ${kind} with key "${key}".`;
    if (kind === 'component') {
      const action = getAction(entry.actionKey);
      return `${json(entry)}\n\nResolves to action:\n${action ? json(action) : `MISSING — "${entry.actionKey}" is not defined`}`;
    }
    return json(entry);
  },
});

tool({
  name: 'registry_put',
  title: 'Define or change an action',
  description:
    'Write an action into the Registry. This is the main way to build behaviour. Existing keys are overwritten, which is how you change what a live button does without touching the panel. Destructive kinds get confirm forced on regardless of what is passed. Call registry_vocabulary for the full grammar.',
  mutating: true,
  schema: {
    key: z.string().describe('stable identifier, e.g. ticket_open'),
    kind: z.enum(ACTION_KINDS),
    params: z.record(z.string(), z.any()).default({}).describe('kind-specific parameters'),
    requires: z
      .record(z.string(), z.any())
      .nullable()
      .optional()
      .describe('predicate that must pass before this runs, e.g. {"type":"has_role","role_id":"..."}'),
    confirm: z.boolean().optional().describe('force the two-step confirmation path'),
    note: z.string().optional().describe('why this exists — future you will want it'),
  },
  async run({ key, kind, params = {}, requires = null, confirm, note }) {
    const existed = !!getAction(key);
    const action = putAction({ key, kind, params, requires, confirm, note });
    const forced = DESTRUCTIVE_KINDS.has(kind) && !confirm;
    return {
      target: key,
      text: [
        `${existed ? 'Updated' : 'Created'} action "${key}" (${kind}).`,
        forced ? `confirm was forced on — ${kind} cannot be undone.` : null,
        existed ? 'Any live button pointing at this key now does the new thing. No restart needed.' : null,
        '',
        json(action),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

tool({
  name: 'registry_component_put',
  title: 'Define or rebind a component',
  description:
    'Create a component row directly, or repoint an existing one at a different action. Usually panel_publish is the right tool — use this to rebind a button that is already posted.',
  mutating: true,
  schema: {
    key: z.string().optional().describe('omit to mint a new key'),
    action_key: z.string(),
    kind: z.enum(['button', 'select', 'modal']).default('button'),
    spec: z.record(z.string(), z.any()).default({}),
    session_id: z.number().int().nullable().optional(),
  },
  async run({ key, action_key, kind = 'button', spec = {}, session_id = null }) {
    const comp = putComponent({ key, kind, actionKey: action_key, spec, sessionId: session_id });
    return {
      target: comp.key,
      text: `Component ${comp.key} now runs action "${action_key}".\n${json(comp)}`,
    };
  },
});

tool({
  name: 'registry_delete',
  title: 'Delete a Registry entry',
  description:
    'Remove an action or component. Deleting an action that a live button points at leaves that button dead — it will answer "this control is no longer defined" rather than failing silently.',
  mutating: true,
  schema: {
    key: z.string(),
    kind: z.enum(['action', 'component']).default('action'),
  },
  async run({ key, kind = 'action' }) {
    if (kind === 'action') {
      const orphans = listComponents().filter((c) => c.actionKey === key);
      const removed = deleteAction(key);
      if (!removed) return `No action "${key}" to delete.`;
      return {
        target: key,
        text:
          `Deleted action "${key}".` +
          (orphans.length
            ? `\n\n${orphans.length} component(s) now point at nothing: ${orphans.map((o) => o.key).join(', ')}. ` +
              `Repoint them with registry_component_put or remove their panel.`
            : ''),
      };
    }
    const removed = deleteComponent(key);
    return { target: key, text: removed ? `Deleted component "${key}".` : `No component "${key}" to delete.` };
  },
});

tool({
  name: 'registry_vocabulary',
  title: 'The full Registry grammar',
  description:
    'Every action kind with its parameters, every predicate, and every template variable. Read this before composing a system — guessing a parameter name produces an action that stores fine and fails at click time.',
  schema: {},
  async run() {
    return `REGISTRY GRAMMAR

An action is {key, kind, params, requires, confirm}. Actions compose: sequence
runs a list, branch picks one of two, and most kinds take an optional "then".

ACTION KINDS

  reply            params: {content?, embed?{title,description,color,footer}, ephemeral?=true}
                   Answers the interaction. Every user-facing path should end in one.

  message_send     params: {channel_id, content?, embed?}
                   Posts to a channel. channel_id accepts templates.

  channel_create   params: {name, type?=text, parent_id?, topic?,
                            overwrites?[{id,type,allow[],deny[]}], then?}
                   name and topic accept templates. "then" runs with {{created.id}} bound.

  channel_edit     params: {channel_id, name?, topic?, parent_id?}
  channel_delete   params: {channel_id}                          [always confirm]
  thread_create    params: {channel_id, name, auto_archive_minutes?=1440, then?}

  role_grant       params: {role_id, user_id?}    default user_id is the presser
  role_revoke      params: {role_id, user_id?}
  overwrite_set    params: {channel_id, target_id, target_type?=role, allow[], deny[]}
  guild_edit       params: {name}                 renames the server itself

  dm_send          params: {user_id?, content?, embed?}
                   Defaults to the presser. Closed DMs are reported, not fatal.

  reaction_add     params: {emoji, channel_id?, message_id?}
                   Defaults to the message in context, so it works from a trigger.

  counter_bump     params: {key, by?=1, pad?, then?}
                   Bumps a persistent counter and binds {{counter.value}} inside
                   "then". This is how you get ticket-0007 rather than a snowflake.

  modal_open       params: {title, fields[{key,label,style?,required?,placeholder?,max?}],
                            on_submit: <action key>}
                   Values arrive at on_submit as {{field.<key>}}.

  session_op       params: {op: start|promote|archive|close, session_id?, name?}

  sequence         params: {steps: [<action key or inline action>, ...]}
  branch           params: {if: <predicate>, then: <action key>, else?: <action key>}
  log              params: {message}

PREDICATES  (used in "requires" and in branch.if)

  {"type":"always"}
  {"type":"has_role","role_id":"..."}
  {"type":"is_guild_owner"}
  {"type":"in_channel","channel_id":"..."}
  {"type":"channel_exists","name":"..."}
  {"type":"session_state","session_id":1,"state":"testing"}
  {"type":"not","of":<predicate>}
  {"type":"all","of":[<predicate>,...]}
  {"type":"any","of":[<predicate>,...]}

TEMPLATES  (any string parameter)

  {{user.id}} {{user.name}} {{user.mention}}
  {{channel.id}} {{guild.id}}
  {{arg.0}} {{arg.1}}          per-click args from the custom_id
  {{field.<key>}}              modal submission values
  {{created.id}}               inside a "then", the thing just created
  {{session.name}} {{session.id}}
  {{now}} {{today}}

PERMISSION NAMES for allow/deny: see permissions_vocabulary.

WORKED EXAMPLE — a ticket button, entirely as data

  registry_put key=ticket_open kind=channel_create params={
    "name": "ticket-{{user.name}}",
    "parent_id": "<category id>",
    "topic": "Opened by {{user.mention}} at {{now}}",
    "overwrites": [
      {"id":"<guild id>","type":"role","deny":["ViewChannel"]},
      {"id":"{{user.id}}","type":"member","allow":["ViewChannel","SendMessages","ReadMessageHistory"]}
    ],
    "then": {"kind":"reply","params":{"content":"Opened <#{{created.id}}>","ephemeral":true}}
  }

  then panel_publish with a button whose action_key is ticket_open.`;
  },
});
