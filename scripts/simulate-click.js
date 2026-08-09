// Run a component's action as if someone had pressed it.
//
//   node scripts/simulate-click.js <component_key> <user_id> [json-args]
//
// This exercises the real Registry row, the real templates and the real REST
// calls — everything the Dispatcher would do except receiving the interaction.
// It is how a panel gets tested before anyone is asked to click it, and how a
// misconfigured action is found while it is still cheap to fix.
//
// It does create real channels and post real messages. That is the point.

import { closeDb } from '../shared/store.js';
import { getComponent, getAction } from '../shared/registry.js';
import { execute } from '../shared/executor.js';
import { evaluate } from '../shared/predicates.js';
import { buildScope, render } from '../shared/template.js';
import { log as auditLog } from '../shared/audit.js';
import { GUILD_ID, requireEnv } from '../shared/env.js';
import { get, guildRoute, fetchGuild } from '../shared/rest.js';

requireEnv();

const [, , componentKey, userId, rawArgs] = process.argv;
if (!componentKey || !userId) {
  console.error('usage: node scripts/simulate-click.js <component_key> <user_id> [json-args]');
  process.exit(2);
}

const args = rawArgs ? JSON.parse(rawArgs) : [];

const component = getComponent(componentKey);
if (!component) {
  console.error(`No component "${componentKey}". Run: node scripts/call.js panel_components`);
  process.exit(1);
}
const action = getAction(component.actionKey);
if (!action) {
  console.error(`Component "${componentKey}" points at missing action "${component.actionKey}".`);
  process.exit(1);
}

// Pull the real member so roles and display name match what the Dispatcher
// would see. A simulation against invented context proves nothing.
const [member, guild] = await Promise.all([get(guildRoute(`/members/${userId}`)), fetchGuild()]);

const ctx = {
  source: 'dispatcher',
  actor: userId,
  guildId: GUILD_ID,
  guildOwnerId: guild.owner_id,
  user: {
    id: member.user.id,
    username: member.user.username,
    globalName: member.user.global_name,
    displayName: member.nick ?? member.user.global_name ?? member.user.username,
  },
  channel: { id: 'simulated', name: 'simulated' },
  memberRoles: member.roles,
  args,
  fields: {},
  respond: async (payload) => {
    console.log(`  [reply to user] ${payload.content ?? '(embed)'}`);
  },
};

console.log(`\nSimulating: ${componentKey} "${component.spec.label ?? ''}" -> ${component.actionKey} (${action.kind})`);
console.log(`As: ${ctx.user.username} (${userId}), ${member.roles.length} role(s)\n`);

// Report the verdict for visibility, but render the predicate exactly as the
// executor does first. An earlier version checked the raw clause and cheerfully
// announced that "#ticket-user-name" was free — reporting on a predicate the
// executor would never evaluate. The executor re-checks anyway; this is a
// preview, and a preview that disagrees with the thing it previews is worse
// than no preview.
if (action.requires) {
  const verdict = await evaluate(render(action.requires, buildScope(ctx)), ctx);
  console.log(`requires: ${verdict.pass ? 'PASS' : 'BLOCKED'} — ${verdict.reason}\n`);
  if (!verdict.pass) {
    closeDb();
    process.exit(0);
  }
}

try {
  const result = await execute(component.actionKey, ctx);
  console.log(result.log.map((l) => `  ${l}`).join('\n') || '  (no output)');
  auditLog({
    source: 'dispatcher',
    actor: userId,
    op: `simulated:${component.actionKey}`,
    target: componentKey,
    result: 'ok',
    detail: result.log.join(' · '),
  });
  console.log('\nSimulation succeeded.\n');
  closeDb();
} catch (e) {
  console.error(`\nSimulation FAILED: ${e.message}\n`);
  auditLog({
    source: 'dispatcher',
    actor: userId,
    op: `simulated:${component.actionKey}`,
    target: componentKey,
    result: 'error',
    detail: e.message,
  });
  closeDb();
  process.exit(1);
}
