// A 5-field cron matcher, evaluated in local time.
//
// Written here rather than pulled in as a dependency: the whole scheduler needs
// "does this expression match this minute", and that is the function. Keeping it
// in-tree holds the project to two runtime dependencies.
//
//     minute hour day-of-month month day-of-week
//     *  any      a-b  range      */n  step      a,b  list      0 = Sunday

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
];

const MONTH_ALIAS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const DOW_ALIAS = ['sun','mon','tue','wed','thu','fri','sat'];

function alias(token, fieldName) {
  const t = token.toLowerCase();
  if (fieldName === 'month') {
    const i = MONTH_ALIAS.indexOf(t);
    if (i !== -1) return String(i + 1);
  }
  if (fieldName === 'dow') {
    const i = DOW_ALIAS.indexOf(t);
    if (i !== -1) return String(i);
    if (t === '7') return '0'; // both 0 and 7 mean Sunday
  }
  return token;
}

function parseField(raw, field) {
  const values = new Set();

  for (const chunk of String(raw).split(',')) {
    const piece = chunk.trim();
    if (!piece) throw new Error(`empty ${field.name} entry in "${raw}"`);

    const [rangePart, stepPart] = piece.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`bad step "${stepPart}" in ${field.name}`);
    }

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = field.min;
      hi = field.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((x) => Number(alias(x.trim(), field.name)));
      lo = a;
      hi = b;
    } else {
      lo = Number(alias(rangePart.trim(), field.name));
      hi = stepPart === undefined ? lo : field.max;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`bad ${field.name} value "${piece}"`);
    }
    if (lo < field.min || hi > field.max || lo > hi) {
      throw new Error(`${field.name} "${piece}" is outside ${field.min}-${field.max}`);
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return values;
}

export function parse(expression) {
  const parts = String(expression).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expression}"`,
    );
  }
  const sets = FIELDS.map((f, i) => parseField(parts[i], f));
  return {
    expression: parts.join(' '),
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    // Standard cron: when both day fields are restricted, either one matching is
    // enough. When only one is restricted, it alone decides.
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

export function isValid(expression) {
  try {
    parse(expression);
    return true;
  } catch {
    return false;
  }
}

export function matches(parsed, date = new Date()) {
  const c = typeof parsed === 'string' ? parse(parsed) : parsed;

  if (!c.minute.has(date.getMinutes())) return false;
  if (!c.hour.has(date.getHours())) return false;
  if (!c.month.has(date.getMonth() + 1)) return false;

  const domHit = c.dom.has(date.getDate());
  const dowHit = c.dow.has(date.getDay());

  if (c.domRestricted && c.dowRestricted) return domHit || dowHit;
  if (c.domRestricted) return domHit;
  if (c.dowRestricted) return dowHit;
  return true;
}

/** Next firing time strictly after `from`, or null if none within a year. */
export function nextRun(expression, from = new Date()) {
  const c = parse(expression);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(c, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Plain-language summary, for listings and for confirming intent back to a human. */
export function describe(expression) {
  const c = parse(expression);
  const [m, h, dom, mon, dow] = c.expression.split(' ');
  if (m.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `every ${m.slice(2)} minutes`;
  }
  if (m === '*' && h === '*') return 'every minute';
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return `hourly at :${m.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*') {
    return `daily at ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*') {
    return `${dow} at ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  return c.expression;
}
