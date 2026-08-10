// {{...}} substitution for Registry parameters.
//
// Every string parameter in an action runs through here, which is what lets one
// stored row serve every user who presses the button: "ticket-{{user.name}}"
// is a single definition that produces a different channel each time.
//
// An unknown placeholder is left standing rather than replaced with an empty
// string. "ticket-{{user.nmae}}" appearing verbatim in Discord is a typo you can
// see and fix; "ticket-" is a mystery.

const PATTERN = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

export function buildScope(ctx = {}) {
  const { user, channel, guildId, args = [], fields = {}, created, session, extra = {} } = ctx;

  const scope = {
    'guild.id': guildId ?? '',
    'now': new Date().toISOString(),
    'today': new Date().toISOString().slice(0, 10),
    'timestamp': String(Math.floor(Date.now() / 1000)),
  };

  if (user) {
    scope['user.id'] = user.id ?? '';
    scope['user.name'] = user.username ?? user.name ?? '';
    scope['user.mention'] = user.id ? `<@${user.id}>` : '';
    scope['user.display'] = user.displayName ?? user.globalName ?? user.username ?? '';
  }
  if (channel) {
    scope['channel.id'] = channel.id ?? '';
    scope['channel.name'] = channel.name ?? '';
    scope['channel.mention'] = channel.id ? `<#${channel.id}>` : '';
  }
  if (created) {
    // A role and a channel are mentioned differently, and the thing that was
    // just created knows which it is: a Discord role carries a permissions
    // field and no channel type.
    const isRole = created.type === undefined && created.permissions !== undefined;
    scope['created.id'] = created.id ?? '';
    scope['created.name'] = created.name ?? '';
    scope['created.mention'] = created.id ? (isRole ? `<@&${created.id}>` : `<#${created.id}>`) : '';
  }
  if (session) {
    scope['session.id'] = String(session.id ?? '');
    scope['session.name'] = session.name ?? '';
    scope['session.state'] = session.state ?? '';
  }

  args.forEach((v, i) => {
    scope[`arg.${i}`] = String(v ?? '');
  });
  for (const [k, v] of Object.entries(fields)) scope[`field.${k}`] = String(v ?? '');
  for (const [k, v] of Object.entries(extra)) scope[k] = String(v ?? '');

  return scope;
}

export function renderString(text, scope) {
  if (typeof text !== 'string') return text;
  return text.replace(PATTERN, (whole, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(scope, k) ? scope[k] : whole;
  });
}

/** Walk any structure and render every string inside it. */
export function render(value, scope) {
  if (typeof value === 'string') return renderString(value, scope);
  if (Array.isArray(value)) return value.map((v) => render(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, scope);
    return out;
  }
  return value;
}

/** Placeholders a template uses that the current scope cannot fill. */
export function unresolved(value, scope) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PATTERN)) {
        const k = m[1].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(scope, k)) found.add(m[1]);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}
