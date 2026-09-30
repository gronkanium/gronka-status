const NAMES = {
  bot: ['discord bot', '/download /convert /optimize'],
  workers: ['media workers', ''],
  web: ['web.gronka.dev', 'the download page'],
  api: ['api.gronka.dev', 'public api'],
  cdn: ['cdn', "files over discord's size limit"],
};
const ORDER = ['bot', 'workers', 'web', 'api', 'cdn'];
const GROUPS = [
  ['gronka', 'gronka'],
  ['sessions', 'sessions', 'the logins gronka downloads with, kept alive automatically'],
  ['sources', 'sources', 'success rate of real requests'],
];
const WORD = { ok: 'working', degraded: 'slow', down: 'failing', unknown: 'no data', idle: 'quiet' };
const DAYS = 90;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const ago = ms => {
  const s = Math.round(ms / 1000);
  if (s < 90) return s === 1 ? '1 second ago' : `${s} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const when = t =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function history(days, id) {
  const byDay = Object.fromEntries(days.filter(d => d.component === id).map(d => [d.day, d]));
  let ok = 0;
  let total = 0;
  let cells = '';
  for (let i = DAYS - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const d = byDay[key];
    const n = d ? d.ok + d.degraded + d.down : 0;
    ok += d?.ok ?? 0;
    total += n;
    const up = n ? d.ok / n : null;
    const cls = up === null ? 'none' : up >= 0.995 ? 'ok' : up >= 0.95 ? 'slow' : 'down';
    const tip = up === null ? `${key}: no data` : `${key}: ${(up * 100).toFixed(2)}% working`;
    cells += `<i class="${cls}" title="${tip}"></i>`;
  }
  return { cells, uptime: total ? ((ok / total) * 100).toFixed(2) : null };
}

function row(c, days) {
  const [name, note] = NAMES[c.id] ?? [c.label ?? c.id, ''];
  const h = history(days, c.id);
  const extra = [note, c.detail, c.ms ? `${c.ms} ms` : ''].filter(Boolean).join(' · ');
  return `<li>
    <div class="svc"><b>${esc(name)}</b><span>${esc(extra)}</span></div>
    <div class="state ${c.state}">${WORD[c.state] ?? c.state}</div>
    <div class="bars">${h.cells}</div>
    <div class="up">${h.uptime ? `${h.uptime}% working · last ${DAYS} days` : 'history starts today'}</div>
  </li>`;
}

function incidentHtml(i, open) {
  const ups = i.updates
    .map(u => `<li><b>${esc(u.status)}</b> <span>${when(u.at)}</span><p>${esc(u.body)}</p></li>`)
    .join('');
  const span = i.resolved_at ? `resolved after ${ago(i.resolved_at - i.created_at).replace(' ago', '')}` : '';
  return open
    ? `<section class="incident ${i.impact}"><div class="tag">${esc(i.status)}</div>
        <h2>${esc(i.title)}</h2><ul class="ups">${ups}</ul></section>`
    : `<article><h3>${esc(i.title)} <span>${when(i.created_at)} · ${span}</span></h3>
        <p>${esc(i.updates[0]?.body)}</p></article>`;
}

function hero(s, comps, open) {
  const down = comps.filter(c => c.state === 'down');
  const slow = comps.filter(c => c.state === 'degraded');
  const name = c => (NAMES[c.id] ?? [c.label ?? c.id])[0];
  let pose = 'happy';
  let head = "everything's downloading.";
  let lede = 'all systems working.';
  if (s.box.stale) {
    pose = 'asleep';
    head = "we can't reach the bot's machine.";
    lede = `last heard from ${s.box.at ? ago(s.now - s.box.at) : 'never'}. the website checks below are still live.`;
  } else if (open.some(i => i.impact === 'maintenance')) {
    pose = 'coffee';
    head = 'maintenance in progress.';
    lede = 'see the note below.';
  } else if (open.length) {
    pose = open[0].impact === 'major' ? 'nope' : 'slow';
    head = `${open[0].title}.`;
    lede = open.length > 1 ? `and ${open.length - 1} more. details below.` : 'details below.';
  } else if (down.length) {
    pose = 'nope';
    head = down.length === 1 ? `${name(down[0])} is down.` : `${down.length} things are down.`;
    lede = `everything else ${down.length === comps.length ? 'too' : 'works'}.`;
  } else if (slow.length) {
    pose = 'slow';
    head = `${name(slow[0])} is slow.`;
    lede = 'working, just not at full speed.';
  }
  $('peng').src = `p/${pose}.svg`;
  $('headline').textContent = head;
  $('lede').textContent = `${lede} checked ${s.box.at ? ago(s.now - s.box.at) : 'never'}.`;
  document.title = pose === 'happy' ? 'gronka status' : `(!) gronka status`;
}

async function load() {
  const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
  const comps = s.components;
  const open = s.incidents.filter(i => !i.resolved_at);
  const past = s.incidents.filter(i => i.resolved_at);
  hero(s, comps.filter(c => c.state !== 'idle'), open);
  $('active').innerHTML = open.map(i => incidentHtml(i, true)).join('');
  $('past').innerHTML = past.length
    ? past.map(i => incidentHtml(i, false)).join('')
    : '<p class="none">nothing in the last 30 days.</p>';
  $('groups').innerHTML = GROUPS.map(([key, title, sub]) => {
    const list = comps
      .filter(c => c.group === key)
      .sort((a, b) => (ORDER.indexOf(a.id) + 99) % 99 - (ORDER.indexOf(b.id) + 99) % 99);
    if (!list.length) return '';
    return `<section class="group"><h2>${title}${sub ? ` <small>${sub}</small>` : ''}</h2>
      <ul class="svcs">${list.map(c => row(c, s.days)).join('')}</ul></section>`;
  }).join('');
}

load();
setInterval(load, 60000);
