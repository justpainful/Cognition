// Render a transcript_export document as a self-contained HTML page.
//
//   node scripts/build-transcript.js <ticket.json> <context.json> <commentary.json> <out.html>
//
// Everything the page shows comes from the system's own tools: transcript_export
// for the conversation, the members and roles endpoints for identity,
// registry_list and trigger_list for the summary. This file only lays it out.
//
// The page embeds its own data and its avatars as data URIs, so it opens from a
// file:// path with no network and nothing to host.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , ticketPath, contextPath, commentaryPath, outPath] = process.argv;
if (!ticketPath || !contextPath || !commentaryPath || !outPath) {
  console.error('usage: node scripts/build-transcript.js <ticket.json> <context.json> <commentary.json> <out.html>');
  process.exit(2);
}

const ticket = JSON.parse(readFileSync(ticketPath, 'utf8'));
const context = JSON.parse(readFileSync(contextPath, 'utf8'));
const commentary = JSON.parse(readFileSync(commentaryPath, 'utf8'));

const roleById = Object.fromEntries(context.roles.map((r) => [r.id, r]));

// Discord renders a role's colour only when it is non-zero; zero means "inherit".
const roleColour = (r) => (r.color ? `#${r.color.toString(16).padStart(6, '0')}` : '#b5bac1');

function topColour(roleIds = []) {
  const coloured = roleIds
    .map((id) => roleById[id])
    .filter((r) => r && r.color)
    .sort((a, b) => b.position - a.position);
  return coloured.length ? roleColour(coloured[0]) : '#f2f3f5';
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Discord markup, in the order that avoids re-processing our own output. */
function renderContent(text, participants) {
  let s = esc(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="code">${code.trim()}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/<@(\d+)>/g, (_, id) => {
    const p = participants.find((x) => x.id === id);
    return `<span class="mention" data-profile="${id}">@${esc(p?.nick || p?.global_name || p?.username || id)}</span>`;
  });
  s = s.replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#channel</span>');
  s = s.replace(/<#(\d+)>/g, '<span class="mention">#channel</span>');
  // <t:unix:R> — the page is read later than it was written, so show the absolute time.
  s = s.replace(/&lt;t:(\d+):([a-zA-Z])&gt;/g, (_, unix) =>
    `<span class="mention">${new Date(Number(unix) * 1000).toLocaleString('en-GB')}</span>`);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\n/g, '<br>');
}

const time = (iso) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);
const dayLabel = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const payload = {
  channel: ticket.channel,
  guild: context.guild,
  exportedAt: ticket.exported_at,
  messages: ticket.messages,
  participants: ticket.participants,
  roles: context.roles,
  avatars: context.avatars,
  commentary,
};

// ---- message stream --------------------------------------------------------

let lastAuthor = null;
let lastDay = null;
let lastAt = 0;

const stream = ticket.messages
  .map((m, i) => {
    const p = ticket.participants.find((x) => x.id === m.author.id) ?? {};
    const note = commentary.notes[String(i)];
    const day = dayKey(m.at);

    let divider = '';
    if (day !== lastDay) {
      divider = `<div class="daybreak"><span>${dayLabel(m.at)}</span></div>`;
      lastDay = day;
      lastAuthor = null;
    }

    // Discord groups consecutive messages from one author within a few minutes.
    const gap = new Date(m.at).getTime() - lastAt;
    const grouped = m.author.id === lastAuthor && gap < 7 * 60_000 && !divider;
    lastAuthor = m.author.id;
    lastAt = new Date(m.at).getTime();

    const colour = topColour(p.roles);
    const name = p.nick || p.global_name || m.author.global_name || m.author.username;

    const embeds = m.embeds
      .map((e) => {
        const stripe = e.color ? `#${e.color.toString(16).padStart(6, '0')}` : '#4f545c';
        return `<div class="embed" style="border-left-color:${stripe}">
        ${e.title ? `<div class="embed-title">${renderContent(e.title, ticket.participants)}</div>` : ''}
        ${e.description ? `<div class="embed-desc">${renderContent(e.description, ticket.participants)}</div>` : ''}
        ${e.fields.map((f) => `<div class="embed-field"><div class="ef-name">${esc(f.name)}</div><div class="ef-val">${renderContent(f.value, ticket.participants)}</div></div>`).join('')}
        ${e.footer ? `<div class="embed-footer">${esc(e.footer)}</div>` : ''}
      </div>`;
      })
      .join('');

    const buttons = m.components.length
      ? `<div class="buttons">${m.components
          .map((c) => `<span class="btn s${c.style ?? 2}">${esc(c.label ?? '')}</span>`)
          .join('')}</div>`
      : '';

    const noteHtml = note
      ? `<aside class="note ${note.tone}"><span class="note-tag">${
          { system: 'النظام', bot: 'Cognition', human: 'ملاحظة', flag: 'نقطة تحول' }[note.tone] ?? 'ملاحظة'
        }</span>${esc(note.text)}</aside>`
      : '';

    return `${divider}
<div class="msg${grouped ? ' grouped' : ''}" data-author="${m.author.id}" data-i="${i}" id="m${i}">
  <div class="gutter">${
    grouped
      ? `<span class="hovertime">${time(m.at)}</span>`
      : `<img class="avatar" data-av="${m.author.id}" alt="" data-profile="${m.author.id}">`
  }</div>
  <div class="body">
    ${
      grouped
        ? ''
        : `<div class="head"><span class="name" style="color:${colour}" data-profile="${m.author.id}">${esc(name)}</span>${
            m.author.bot ? '<span class="tag">APP</span>' : ''
          }<span class="ts">${time(m.at)}</span></div>`
    }
    ${m.content ? `<div class="text">${renderContent(m.content, ticket.participants)}</div>` : ''}
    ${embeds}${buttons}
    ${noteHtml}
  </div>
</div>`;
  })
  .join('\n');

// ---- sidebars --------------------------------------------------------------

const memberList = ticket.participants
  .map((p) => {
    const colour = topColour(p.roles);
    return `<div class="member" data-profile="${p.id}">
    <img class="avatar sm" data-av="${p.id}" alt="">
    <div><div class="m-name" style="color:${colour}">${esc(p.nick || p.global_name || p.username)}</div>
    <div class="m-sub">${p.bot ? 'تطبيق' : p.id === context.guild.owner_id ? 'مالك السيرفر' : 'عضو'} · ${p.message_count} رسالة</div></div>
  </div>`;
  })
  .join('');

const actionRows = (commentary.system?.actions ?? []).join('');

const html = `<title>${esc(commentary.title)}</title>
<style>
  :root{
    --bg:#313338; --bg2:#2b2d31; --bg3:#1e1f22; --bg4:#232428;
    --tx:#dbdee1; --tx2:#b5bac1; --tx3:#949ba4; --hd:#f2f3f5;
    --acc:#5865f2; --gr:#3ba55d; --rd:#ed4245; --yl:#faa81a;
    --bd:#3f4147;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font-family:"Noto Sans Arabic","Segoe UI",Roboto,system-ui,sans-serif;
    font-size:15px;line-height:1.45;direction:rtl}
  .app{display:grid;grid-template-columns:250px 1fr 240px;height:100vh}
  @media(max-width:1100px){.app{grid-template-columns:1fr}.side,.members{display:none}}

  .side{background:var(--bg2);display:flex;flex-direction:column;overflow:hidden}
  .server{padding:14px 16px;border-bottom:1px solid var(--bg3);font-weight:700;color:var(--hd);
    display:flex;align-items:center;gap:8px}
  .server small{font-weight:400;color:var(--tx3);font-size:12px}
  .navs{padding:10px;overflow-y:auto;flex:1}
  .navlabel{font-size:11px;text-transform:uppercase;color:var(--tx3);padding:8px 8px 4px;font-weight:700;letter-spacing:.5px}
  .chan{padding:7px 10px;border-radius:6px;color:var(--tx2);cursor:default;display:flex;gap:6px;align-items:center;font-size:14px}
  .chan.active{background:#404249;color:var(--hd)}
  .chan .hash{color:var(--tx3)}
  .stat{padding:8px 10px;font-size:12px;color:var(--tx3);display:flex;justify-content:space-between}
  .stat b{color:var(--tx);font-weight:600}

  .main{display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
  .top{height:52px;border-bottom:1px solid var(--bg3);display:flex;align-items:center;
    padding:0 16px;gap:14px;flex-shrink:0;background:var(--bg)}
  .top h1{font-size:15px;margin:0;color:var(--hd)}
  .top .sep{width:1px;height:22px;background:var(--bd)}
  .tabs{display:flex;gap:4px;margin-inline-start:auto}
  .tab{padding:5px 12px;border-radius:6px;font-size:13px;background:none;border:0;color:var(--tx2);cursor:pointer;font-family:inherit}
  .tab:hover{background:#3f4248;color:var(--hd)}
  .tab.on{background:var(--acc);color:#fff}
  .search{background:var(--bg3);border:0;border-radius:5px;padding:6px 10px;color:var(--tx);
    font-family:inherit;font-size:13px;width:180px}
  .search::placeholder{color:var(--tx3)}

  .scroll{flex:1;overflow-y:auto;padding:16px 0 60px}
  .pane{display:none}.pane.on{display:block}

  .daybreak{display:flex;align-items:center;gap:12px;margin:22px 18px 10px;color:var(--tx3);font-size:12px}
  .daybreak::before,.daybreak::after{content:"";flex:1;height:1px;background:var(--bd)}

  .msg{display:grid;grid-template-columns:56px 1fr;padding:3px 18px;position:relative}
  .msg:hover{background:#2e3035}
  .msg.grouped{margin-top:0}
  .msg:not(.grouped){margin-top:14px}
  .gutter{display:flex;justify-content:center;padding-top:2px}
  .hovertime{font-size:10px;color:var(--tx3);opacity:0;padding-top:5px}
  .msg:hover .hovertime{opacity:1}
  .avatar{width:40px;height:40px;border-radius:50%;cursor:pointer}
  .avatar.sm{width:32px;height:32px}
  .head{display:flex;align-items:baseline;gap:8px;margin-bottom:1px}
  .name{font-weight:600;cursor:pointer}
  .name:hover{text-decoration:underline}
  .tag{background:var(--acc);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600}
  .ts{font-size:11px;color:var(--tx3)}
  .text{white-space:normal;word-wrap:break-word;color:var(--tx)}
  .text a{color:#00a8fc;text-decoration:none}.text a:hover{text-decoration:underline}
  code{background:var(--bg3);padding:1px 4px;border-radius:3px;font-size:13px;font-family:Consolas,monospace;direction:ltr;display:inline-block}
  pre.code{background:var(--bg3);border:1px solid var(--bd);border-radius:5px;padding:9px;
    overflow-x:auto;font-family:Consolas,monospace;font-size:13px;direction:ltr;text-align:left;white-space:pre-wrap}
  .mention{background:rgba(88,101,242,.3);color:#c9cdfb;padding:0 2px;border-radius:3px;cursor:pointer}

  .embed{background:var(--bg4);border-left:4px solid var(--acc);border-radius:4px;
    padding:9px 12px;margin-top:5px;max-width:520px}
  .embed-title{font-weight:600;color:var(--hd);margin-bottom:3px}
  .embed-desc{font-size:14px;color:var(--tx2)}
  .embed-field{margin-top:7px}
  .ef-name{font-weight:600;font-size:13px;color:var(--hd)}
  .ef-val{font-size:13px;color:var(--tx2)}
  .embed-footer{font-size:11px;color:var(--tx3);margin-top:7px}

  .buttons{display:flex;gap:8px;margin-top:7px;flex-wrap:wrap}
  .btn{padding:6px 14px;border-radius:4px;font-size:13px;font-weight:500;background:#4e5058;color:#fff}
  .btn.s1{background:var(--acc)}.btn.s4{background:var(--rd)}.btn.s3{background:var(--gr)}

  .note{display:block;margin:7px 0 4px;padding:8px 11px;border-radius:5px;font-size:13px;
    background:#2b2d31;border-inline-start:3px solid var(--tx3);color:var(--tx2);max-width:640px}
  .note-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.4px;
    padding:1px 6px;border-radius:3px;margin-inline-end:7px;background:#404249;color:var(--tx2)}
  .note.flag{border-inline-start-color:var(--yl);background:#2f2b22}
  .note.flag .note-tag{background:var(--yl);color:#1e1f22}
  .note.system{border-inline-start-color:var(--gr);background:#232a25}
  .note.system .note-tag{background:var(--gr);color:#fff}
  .note.bot{border-inline-start-color:var(--acc);background:#25262e}
  .note.bot .note-tag{background:var(--acc);color:#fff}
  body.hidenotes .note{display:none}

  .members{background:var(--bg2);padding:14px 10px;overflow-y:auto}
  .members h3{font-size:11px;text-transform:uppercase;color:var(--tx3);margin:0 0 8px 6px;letter-spacing:.5px}
  .member{display:flex;gap:9px;align-items:center;padding:6px;border-radius:6px;cursor:pointer}
  .member:hover{background:#35373c}
  .m-name{font-weight:500;font-size:14px}
  .m-sub{font-size:11px;color:var(--tx3)}

  .sum{max-width:820px;margin:0 auto;padding:8px 24px 40px}
  .sum h2{color:var(--hd);font-size:21px;margin:22px 0 6px}
  .sum p{color:var(--tx2);line-height:1.75}
  .headline{font-size:17px;color:var(--hd);border-inline-start:3px solid var(--acc);
    padding-inline-start:13px;margin:14px 0 18px;line-height:1.6}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:11px;margin:18px 0}
  .card{background:var(--bg2);border-radius:8px;padding:13px}
  .card .n{font-size:25px;font-weight:700;color:var(--hd)}
  .card .l{font-size:12px;color:var(--tx3);margin-top:3px}
  .finding{background:var(--bg2);border-inline-start:3px solid var(--yl);border-radius:6px;
    padding:11px 14px;margin:9px 0;color:var(--tx2);font-size:14px}
  .note-src{font-size:12px;color:var(--tx3);margin-top:22px;padding-top:14px;border-top:1px solid var(--bd)}

  .modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;
    align-items:center;justify-content:center;z-index:50;padding:20px}
  .modal.on{display:flex}
  .profile{background:var(--bg3);border-radius:9px;width:340px;overflow:hidden}
  .banner{height:64px;background:var(--acc)}
  .p-body{padding:0 16px 16px;margin-top:-38px}
  .p-av{width:78px;height:78px;border-radius:50%;border:6px solid var(--bg3);background:var(--bg3)}
  .p-name{font-size:19px;font-weight:700;color:var(--hd);margin-top:7px}
  .p-user{font-size:13px;color:var(--tx3)}
  .p-box{background:var(--bg4);border-radius:7px;padding:12px;margin-top:12px}
  .p-lab{font-size:11px;text-transform:uppercase;color:var(--tx3);font-weight:700;margin-bottom:5px;letter-spacing:.4px}
  .p-val{font-size:13px;color:var(--tx);margin-bottom:11px}
  .rolechips{display:flex;flex-wrap:wrap;gap:5px}
  .rolechip{display:flex;align-items:center;gap:5px;background:#35373c;border-radius:4px;
    padding:3px 8px;font-size:12px;color:var(--tx)}
  .dot{width:9px;height:9px;border-radius:50%}
  .close{position:absolute;top:16px;left:16px;background:none;border:0;color:var(--tx2);
    font-size:26px;cursor:pointer;line-height:1}
</style>

<div class="app">
  <nav class="side">
    <div class="server">${esc(context.guild.name)}<small>خادم</small></div>
    <div class="navs">
      <div class="navlabel">Tickets [TEST]</div>
      <div class="chan active"><span class="hash">#</span>${esc(ticket.channel.name)}</div>
      <div class="navlabel">إحصاء</div>
      <div class="stat"><span>الرسائل</span><b>${ticket.message_count}</b></div>
      <div class="stat"><span>المشاركون</span><b>${ticket.participants.length}</b></div>
      <div class="stat"><span>الرولات</span><b>${context.roles.length}</b></div>
      <div class="stat"><span>التعليقات</span><b>${Object.keys(commentary.notes).length}</b></div>
    </div>
  </nav>

  <main class="main">
    <header class="top">
      <h1><span style="color:var(--tx3)">#</span> ${esc(ticket.channel.name)}</h1>
      <div class="sep"></div>
      <input class="search" id="q" placeholder="بحث في الرسائل">
      <div class="tabs">
        <button class="tab on" data-pane="chat">المحادثة</button>
        <button class="tab" data-pane="sum">ملخص Cognition</button>
        <button class="tab" id="toggleNotes">إخفاء التعليقات</button>
      </div>
    </header>

    <div class="scroll">
      <section class="pane on" id="chat">${stream}</section>

      <section class="pane" id="sum">
        <div class="sum">
          <h2>${esc(commentary.title)}</h2>
          <div class="headline">${esc(commentary.summary.headline)}</div>

          <div class="cards">
            <div class="card"><div class="n">${ticket.message_count}</div><div class="l">رسالة</div></div>
            <div class="card"><div class="n">${ticket.participants.length}</div><div class="l">مشارك</div></div>
            <div class="card"><div class="n">${Object.values(commentary.notes).filter((n) => n.tone === 'flag').length}</div><div class="l">نقطة تحول</div></div>
            <div class="card"><div class="n">${commentary.summary.outcomes.length}</div><div class="l">ثغرة سُدّت</div></div>
          </div>

          <h2>ما الذي حدث</h2>
          <p>${esc(commentary.summary.body)}</p>

          <h2>ما خرج به النظام</h2>
          ${commentary.summary.outcomes.map((o) => `<div class="finding">${esc(o)}</div>`).join('')}
          ${actionRows}

          <div class="note-src">${esc(commentary.summary.stats_note)}<br>
          صُدّرت في ${new Date(ticket.exported_at).toLocaleString('en-GB')} · القناة <code>${ticket.channel.id}</code></div>
        </div>
      </section>
    </div>
  </main>

  <aside class="members">
    <h3>المشاركون — ${ticket.participants.length}</h3>
    ${memberList}
  </aside>
</div>

<div class="modal" id="modal"><div class="profile" id="pcard"></div></div>

<script>
const DATA = ${JSON.stringify(payload)};

const byId = id => DATA.participants.find(p => p.id === id);
const roleOf = id => DATA.roles.find(r => r.id === id);
const hex = c => c ? '#' + c.toString(16).padStart(6,'0') : '#b5bac1';

document.querySelectorAll('.tab[data-pane]').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab[data-pane]').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('on'));
  t.classList.add('on');
  document.getElementById(t.dataset.pane).classList.add('on');
});

const tn = document.getElementById('toggleNotes');
tn.onclick = () => {
  document.body.classList.toggle('hidenotes');
  tn.textContent = document.body.classList.contains('hidenotes') ? 'إظهار التعليقات' : 'إخفاء التعليقات';
};

document.getElementById('q').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.msg').forEach(m => {
    m.style.display = !q || m.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.daybreak').forEach(d => { d.style.display = q ? 'none' : ''; });
};

function openProfile(id) {
  const p = byId(id);
  if (!p) return;
  const roles = (p.roles || []).map(roleOf).filter(Boolean).sort((a,b) => b.position - a.position);
  const coloured = roles.find(r => r.color);
  const accent = coloured ? hex(coloured.color) : '#5865f2';
  const joined = p.joined_at ? new Date(p.joined_at).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) : 'غير معروف';

  document.getElementById('pcard').innerHTML =
    '<div class="banner" style="background:' + accent + '"></div>' +
    '<div class="p-body">' +
      '<img class="p-av" src="' + (DATA.avatars[id] || '') + '" alt="">' +
      '<div class="p-name">' + (p.nick || p.global_name || p.username) + '</div>' +
      '<div class="p-user">' + p.username + (p.bot ? ' · تطبيق' : '') + '</div>' +
      '<div class="p-box">' +
        '<div class="p-lab">المعرّف</div><div class="p-val"><code>' + p.id + '</code></div>' +
        '<div class="p-lab">انضم</div><div class="p-val">' + joined + '</div>' +
        '<div class="p-lab">في هذه التذكرة</div><div class="p-val">' + p.message_count + ' رسالة</div>' +
        '<div class="p-lab">الرولات — ' + roles.length + '</div>' +
        '<div class="rolechips">' + (roles.length
            ? roles.map(r => '<span class="rolechip"><span class="dot" style="background:' + hex(r.color) + '"></span>' + r.name + (r.permissions === '0' ? ' · بلا صلاحيات' : '') + '</span>').join('')
            : '<span class="p-val">لا رولات</span>') +
        '</div>' +
      '</div>' +
    '</div>' +
    '<button class="close" onclick="closeProfile()">&times;</button>';
  document.getElementById('modal').classList.add('on');
}
function closeProfile(){ document.getElementById('modal').classList.remove('on'); }

document.addEventListener('click', e => {
  const t = e.target.closest('[data-profile]');
  if (t) openProfile(t.dataset.profile);
});
document.getElementById('modal').onclick = e => { if (e.target.id === 'modal') closeProfile(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProfile(); });

// Avatars are carried once in DATA and applied here. Inlining the data URI per
// message made the file an order of magnitude bigger for no benefit.
document.querySelectorAll('[data-av]').forEach(img => {
  const src = DATA.avatars[img.dataset.av];
  if (src) img.src = src;
});

document.querySelectorAll('.member').forEach(m => {
  m.addEventListener('dblclick', () => {
    const id = m.dataset.profile;
    document.getElementById('q').value = '';
    document.querySelectorAll('.msg').forEach(x => {
      x.style.display = x.dataset.author === id ? '' : 'none';
    });
  });
});
</script>`;

writeFileSync(outPath, html, 'utf8');
console.log(`wrote ${outPath}`);
console.log(`  ${ticket.message_count} messages · ${ticket.participants.length} participants · ${Object.keys(commentary.notes).length} notes`);
console.log(`  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, self-contained`);
