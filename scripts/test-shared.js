// Tests for the pure logic: cron matching, name tagging, custom_id encoding,
// the confirmation guard, templates, and Registry validation.
//
// Nothing here touches Discord, so it runs in CI with no token. Everything that
// does touch Discord is covered by scripts/smoke.js and scripts/classifer-check.js,
// which need real credentials.
//
//   npm test

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the store at a throwaway directory before anything imports env.js, so a
// test run never touches the real registry. Hence the dynamic imports below.
process.env.COGNITION_HOME = mkdtempSync(join(tmpdir(), 'cognition-test-'));

const cron = await import('../shared/cron.js');
const naming = await import('../shared/naming.js');
const customid = await import('../shared/customid.js');
const guard = await import('../shared/guard.js');
const registry = await import('../shared/registry.js');
const template = await import('../shared/template.js');
const predicates = await import('../shared/predicates.js');
const { closeDb } = await import('../shared/store.js');

let passed = 0;
let failed = 0;
let group = '';

const describe = (name) => {
  group = name;
  console.log(`\n${name}`);
};
const t = (name, condition) => {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}   [${group}]`);
  }
};
const throws = (name, fn) => {
  try {
    fn();
    t(name, false);
  } catch {
    t(name, true);
  }
};

// ---------------------------------------------------------------- cron

describe('cron');
t('matches every minute', cron.matches('* * * * *', new Date(2026, 0, 1, 3, 7)));
t('*/5 matches :10', cron.matches('*/5 * * * *', new Date(2026, 0, 1, 3, 10)));
t('*/5 skips :11', !cron.matches('*/5 * * * *', new Date(2026, 0, 1, 3, 11)));
t('exact time matches', cron.matches('57 8 * * *', new Date(2026, 0, 1, 8, 57)));
t('exact time skips other hour', !cron.matches('57 8 * * *', new Date(2026, 0, 1, 9, 57)));
t('range 1-5 includes 3', cron.matches('0 9 * * 1-5', new Date(2026, 7, 12, 9, 0)));
t('range 1-5 excludes Sunday', !cron.matches('0 9 * * 1-5', new Date(2026, 7, 9, 9, 0)));
t('list a,b matches second', cron.matches('0 9,17 * * *', new Date(2026, 0, 1, 17, 0)));
t('month alias', cron.matches('0 0 1 jan *', new Date(2026, 0, 1, 0, 0)));
t('dow alias', cron.matches('0 9 * * mon', new Date(2026, 7, 10, 9, 0)));
t('sunday as 7', cron.matches('0 9 * * 7', new Date(2026, 7, 9, 9, 0)));
// Standard cron: restricted dom AND dow means "either", not "both".
t('dom|dow is OR when both restricted', cron.matches('0 0 1 * 5', new Date(2026, 0, 1, 0, 0)));
t('rejects 4 fields', !cron.isValid('* * * *'));
t('rejects 6 fields', !cron.isValid('* * * * * *'));
t('rejects minute 60', !cron.isValid('60 * * * *'));
t('rejects hour 24', !cron.isValid('* 24 * * *'));
t('rejects reversed range', !cron.isValid('* * * * 5-1'));
t('rejects zero step', !cron.isValid('*/0 * * * *'));
t('nextRun moves to tomorrow', cron.nextRun('0 9 * * *', new Date(2026, 0, 1, 10, 0)).getDate() === 2);
t('nextRun is strictly after', cron.nextRun('* * * * *', new Date(2026, 0, 1, 10, 0)).getMinutes() === 1);
t('describe daily', cron.describe('0 9 * * *') === 'daily at 09:00');
t('describe interval', cron.describe('*/5 * * * *') === 'every 5 minutes');

// ---------------------------------------------------------------- naming

describe('naming');
t('strips [TEST] from a category', naming.stripTag('Tickets [TEST]', '[TEST]') === 'Tickets');
t('strips test from a slug', naming.stripTag('ticket-open-test', '[TEST]') === 'ticket-open');
t('adds tag', naming.addTag('Tickets', '[TEST]') === 'Tickets [TEST]');
t('adding twice is idempotent', naming.addTag(naming.addTag('Tickets', '[TEST]'), '[TEST]') === 'Tickets [TEST]');
t('lifecycle testing', naming.lifecycleOf('Tickets [TEST]') === 'testing');
t('lifecycle archived', naming.lifecycleOf('Tickets [ARCHIVED]') === 'archived');
t('lifecycle permanent', naming.lifecycleOf('Tickets') === 'permanent');
t('archived wins over test', naming.lifecycleOf('Tickets [TEST] [ARCHIVED]') === 'archived');
t('slug lowercases and dashes', naming.tidySlug('Ticket Open!!') === 'ticket-open');
t('slug keeps arabic', naming.tidySlug('تذاكر Open') === 'تذاكر-open');
t('slug trims edge dashes', naming.tidySlug('--x--') === 'x');

// ---------------------------------------------------------------- custom_id

describe('custom_id');
const key = customid.newKey();
t('key is 10 chars', key.length === 10);
t('keys are distinct', customid.newKey() !== customid.newKey());
t('round trips', customid.decode(customid.encode(key, ['123']))?.key === key);
t('round trips args', customid.decode(customid.encode(key, ['a', 'b']))?.args.join() === 'a,b');
t('ignores foreign ids', customid.decode('some_other_bot:button') === null);
t('ignores empty', customid.decode('') === null);
t('ignores non-string', customid.decode(undefined) === null);
throws('rejects ids over 100 chars', () => customid.encode(key, ['x'.repeat(120)]));
throws('rejects a key containing the separator', () => customid.encode('a|b'));

// ---------------------------------------------------------------- guard

describe('guard');
const planned = guard.plan({ op: 'channel_delete', params: { id: '42' }, preview: 'deletes #x' });
t('plan returns a token', typeof planned.token === 'string' && planned.token.length > 10);
t('plan is listed as pending', guard.listPending().some((p) => p.token === planned.token));
throws('rejects changed params', () => guard.redeem(planned.token, { op: 'channel_delete', params: { id: '99' } }));
throws('rejects a different op', () => guard.redeem(planned.token, { op: 'role_delete', params: { id: '42' } }));
t('accepts matching params', guard.redeem(planned.token, { op: 'channel_delete', params: { id: '42' } }).op === 'channel_delete');
throws('is single use', () => guard.redeem(planned.token, { op: 'channel_delete', params: { id: '42' } }));
throws('rejects an unknown token', () => guard.redeem('not-a-token'));
throws('requires a preview', () => guard.plan({ op: 'channel_delete', params: {}, preview: '' }));
t('hash ignores key order', guard.hashOp('x', { a: 1, b: 2 }) === guard.hashOp('x', { b: 2, a: 1 }));
t('hash distinguishes values', guard.hashOp('x', { a: 1 }) !== guard.hashOp('x', { a: 2 }));
t('channel_delete is gated', guard.isGated('channel_delete'));
t('channel_edit is not gated', !guard.isGated('channel_edit'));

// ---------------------------------------------------------------- templates

describe('templates');
const scope = template.buildScope({
  user: { id: '7', username: 'kuroi' },
  channel: { id: '9', name: 'general' },
  guildId: '1',
  args: ['alpha'],
  fields: { reason: 'because' },
});
t('renders user name', template.renderString('ticket-{{user.name}}', scope) === 'ticket-kuroi');
t('renders a mention', template.renderString('{{user.mention}}', scope) === '<@7>');
t('renders an arg', template.renderString('{{arg.0}}', scope) === 'alpha');
t('renders a modal field', template.renderString('{{field.reason}}', scope) === 'because');
t('is case insensitive', template.renderString('{{USER.NAME}}', scope) === 'kuroi');
t('tolerates whitespace', template.renderString('{{ user.name }}', scope) === 'kuroi');
// A typo must stay visible rather than silently becoming an empty string.
t('leaves unknown placeholders standing', template.renderString('{{user.nmae}}', scope) === '{{user.nmae}}');
t('renders nested structures', template.render({ a: ['{{user.id}}'] }, scope).a[0] === '7');
t('reports unresolved keys', template.unresolved({ x: '{{created.id}}' }, scope).includes('created.id'));
// A requires clause is rendered against the same scope as params, which is what
// makes "one open ticket each" expressible as {"name":"ticket-{{user.name}}"}.
// Before this, the raw clause was evaluated and matched nothing.
t(
  'renders a predicate clause',
  template.render({ type: 'channel_absent', name: 'ticket-{{user.name}}' }, scope).name === 'ticket-kuroi',
);

// ---------------------------------------------------------------- predicates

describe('predicates');
t('always passes', (await predicates.evaluate({ type: 'always' }, {})).pass);
t('never fails', !(await predicates.evaluate({ type: 'never' }, {})).pass);
t('null requirement passes', (await predicates.evaluate(null, {})).pass);
t('has_role passes when held', (await predicates.evaluate({ type: 'has_role', role_id: '5' }, { memberRoles: ['5'] })).pass);
t('has_role fails when absent', !(await predicates.evaluate({ type: 'has_role', role_id: '5' }, { memberRoles: ['6'] })).pass);
t('unknown type fails closed', !(await predicates.evaluate({ type: 'nonsense' }, {})).pass);
t('unknown type explains itself', (await predicates.evaluate({ type: 'nonsense' }, {})).reason.includes('unknown'));
t('not inverts', (await predicates.evaluate({ type: 'not', of: { type: 'never' } }, {})).pass);
t('all requires every branch', !(await predicates.evaluate({ type: 'all', of: [{ type: 'always' }, { type: 'never' }] }, {})).pass);
t('any accepts one branch', (await predicates.evaluate({ type: 'any', of: [{ type: 'never' }, { type: 'always' }] }, {})).pass);
t('is_guild_owner matches', (await predicates.evaluate({ type: 'is_guild_owner' }, { user: { id: '3' }, guildOwnerId: '3' })).pass);
t('is_guild_owner rejects others', !(await predicates.evaluate({ type: 'is_guild_owner' }, { user: { id: '4' }, guildOwnerId: '3' })).pass);

// ---------------------------------------------------------------- registry

describe('registry');
registry.putAction({ key: 't_reply', kind: 'reply', params: { content: 'hi' } });
t('action round trips', registry.getAction('t_reply').params.content === 'hi');
t('action appears in the list', registry.listActions().some((a) => a.key === 't_reply'));
throws('rejects an unknown kind', () => registry.putAction({ key: 'bad', kind: 'not_a_kind' }));
throws('rejects a keyless action', () => registry.putAction({ kind: 'reply' }));
t('forces confirm on channel_delete', registry.putAction({ key: 't_del', kind: 'channel_delete', params: {} }).confirm === true);
t('overwrite updates in place', registry.putAction({ key: 't_reply', kind: 'reply', params: { content: 'bye' } }).params.content === 'bye');

const comp = registry.putComponent({ actionKey: 't_reply', spec: { label: 'Hi' } });
t('component mints a key', comp.key.length === 10);
t('component resolves', registry.getComponent(comp.key).actionKey === 't_reply');
throws('rejects a dangling action reference', () => registry.putComponent({ actionKey: 'nope' }));

const session = registry.createSession({ name: 'Test', channels: [{ id: '1', name: 'a' }] });
t('session is created building', session.state === 'building');
t('session updates state', registry.updateSession(session.id, { state: 'promoted' }).state === 'promoted');
throws('rejects an unknown session state', () => registry.updateSession(session.id, { state: 'bogus' }));

throws('schedule rejects a missing action', () => registry.putSchedule({ key: 's', cron: '* * * * *', actionKey: 'nope' }));
registry.putSchedule({ key: 's_ok', cron: '*/5 * * * *', actionKey: 't_reply' });
t('schedule round trips', registry.getSchedule('s_ok').cron === '*/5 * * * *');
t('schedule deletes', registry.deleteSchedule('s_ok') && registry.getSchedule('s_ok') === null);

// ---------------------------------------------------------------- triggers

describe('triggers');
const triggers = await import('../shared/triggers.js');

registry.putAction({ key: 't_post', kind: 'message_send', params: { channel_id: '1', content: 'x' } });
t('trigger round trips', triggers.putTrigger({ key: 'tg1', event: 'message_create', actionKey: 't_post' }).event === 'message_create');
throws('rejects an unknown event', () => triggers.putTrigger({ key: 'tg2', event: 'nope', actionKey: 't_post' }));
throws('rejects a missing action', () => triggers.putTrigger({ key: 'tg3', event: 'member_join', actionKey: 'nope' }));
// A filter key the event never supplies would never match, and the trigger
// would look broken rather than misconfigured.
throws('rejects a filter key the event cannot supply', () =>
  triggers.putTrigger({ key: 'tg4', event: 'member_join', actionKey: 't_post', filter: { contains: 'hi' } }));
t('accepts a valid filter', triggers.putTrigger({ key: 'tg5', event: 'message_create', actionKey: 't_post', filter: { contains: 'hi' } }).filter.contains === 'hi');
t('lists by event', triggers.listTriggers({ event: 'message_create' }).length >= 2);
t('deletes', triggers.deleteTrigger('tg5') && !triggers.getTrigger('tg5'));

describe('trigger matching');
const m = (f, p) => triggers.matches(f, p).pass;
t('empty filter matches', m({}, { content: 'anything' }));
t('contains matches', m({ contains: 'cog' }, { content: 'hello Cognition' }));
t('contains is case insensitive', m({ contains: 'COG' }, { content: 'cognition' }));
t('contains rejects a miss', !m({ contains: 'zzz' }, { content: 'hello' }));
t('starts_with matches', m({ starts_with: '!' }, { content: '!ping' }));
t('starts_with rejects mid-string', !m({ starts_with: '!' }, { content: 'a !ping' }));
t('channel_id matches', m({ channel_id: '9' }, { channelId: '9' }));
t('channel_id rejects another channel', !m({ channel_id: '9' }, { channelId: '8' }));
t('has_role matches', m({ has_role: '5' }, { memberRoles: ['5', '6'] }));
t('has_role rejects when absent', !m({ has_role: '5' }, { memberRoles: ['6'] }));
t('emoji matches', m({ emoji: '👀' }, { emoji: '👀' }));
// Bots are excluded unless asked for, because an action that posts a message
// would otherwise retrigger itself at gateway speed.
t('bots excluded by default', !m({}, { isBot: true, content: 'x' }));
t('from_bot opts them back in', m({ from_bot: true }, { isBot: true, content: 'x' }));
t('humans unaffected by from_bot', m({}, { isBot: false, content: 'x' }));

describe('counters');
t('starts at zero', triggers.readCounter('c_test') === 0);
t('bumps by one', triggers.bumpCounter('c_test') === 1);
t('bumps by n', triggers.bumpCounter('c_test', 5) === 6);
t('persists', triggers.readCounter('c_test') === 6);
t('appears in the list', triggers.listCounters().some((c) => c.key === 'c_test'));

// ---------------------------------------------------------------- version

describe('engine fingerprint');
const version = await import('../shared/version.js');
const h1 = version.engineHash();
t('hash is stable across calls', h1 === version.engineHash());
t('hash is a short hex digest', /^[0-9a-f]{16}$/.test(h1));

// Every kind the executor can dispatch must be declared, or registry_put would
// reject an action the engine can actually run.
describe('executor and registry agree');
const executorSource = readFileSync(new URL('../shared/executor.js', import.meta.url), 'utf8');
for (const kind of registry.ACTION_KINDS) {
  t(`${kind} has a case in the executor`, executorSource.includes(`case '${kind}'`));
}

// ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
closeDb();
process.exit(failed ? 1 : 0);
