// What the AutoMod badge actually sees: rules this app created, per guild.
//
// automod-fill.js reports how full a guild is; this reports how much of that
// fullness is ours. The distinction decides the badge — a guild whose nine
// slots were already spent by its owner or another bot counts for nothing, and
// looks identical to a full one until you check creator_id.

import { get } from '../shared/rest.js';

const app = await get('/applications/@me');
const guilds = await get('/users/@me/guilds');

const rows = [];
for (const g of guilds) {
  try {
    const rules = await get(`/guilds/${g.id}/auto-moderation/rules`);
    const mine = rules.filter((r) => r.creator_id === app.id).length;
    rows.push({ name: g.name, id: g.id, total: rules.length, mine, free: 9 - rules.length });
  } catch (e) {
    rows.push({ name: g.name, id: g.id, total: '?', mine: 0, free: 0, err: e.message.slice(0, 60) });
  }
}

rows.sort((a, b) => b.mine - a.mine);
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('server', 32)} ${pad('ours', 6)} ${pad('total', 6)} free`);
for (const r of rows) {
  console.log(`${pad(r.name.slice(0, 31), 32)} ${pad(r.mine, 6)} ${pad(r.total, 6)} ${r.err ? r.err : r.free}`);
}

const ours = rows.reduce((n, r) => n + r.mine, 0);
const free = rows.reduce((n, r) => n + (Number(r.free) || 0), 0);
console.log(`\nours: ${ours}/100 across ${rows.length} guild(s); ${free} slot(s) still free here`);
console.log(`badge flag: ${(app.flags & (1 << 6)) !== 0 ? 'granted' : 'not yet'} (flags ${app.flags})`);
if (ours < 100) console.log(`short by ${100 - ours} — that is ${Math.ceil((100 - ours) / 9)} more empty server(s)`);
