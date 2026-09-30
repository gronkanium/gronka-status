// status.gronka.dev: serves the page, stores reports from the box, probes the public sites itself.

const PROBES = [
  { id: 'web', url: 'https://web.gronka.dev/', ok: r => r.status === 200 },
  { id: 'api', url: 'https://api.gronka.dev/v1/health', ok: async r => r.status === 200 && (await r.json()).ok === true },
  { id: 'cdn', url: 'https://cdn.gronka.dev/', ok: r => r.status < 500 },
];
const STALE_MS = 10 * 60 * 1000;
const SLOW_MS = 4000;
const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved'];
const IMPACTS = ['minor', 'major', 'maintenance'];

const day = t => new Date(t).toISOString().slice(0, 10);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function authorized(request, secret) {
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!secret || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(secret);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

async function tally(db, component, state, at) {
  const col = state === 'ok' ? 'ok' : state === 'down' ? 'down' : 'degraded';
  await db
    .prepare(
      `INSERT INTO daily (component, day, ${col}) VALUES (?, ?, 1)
       ON CONFLICT (component, day) DO UPDATE SET ${col} = ${col} + 1`
    )
    .bind(component, day(at))
    .run();
}

async function probe(env) {
  const at = Date.now();
  for (const p of PROBES) {
    const t0 = Date.now();
    let state = 'down';
    let detail = '';
    try {
      const r = await fetch(p.url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'gronka-status' } });
      const good = await p.ok(r);
      const ms = Date.now() - t0;
      state = good ? (ms > SLOW_MS ? 'degraded' : 'ok') : 'down';
      detail = good ? '' : `http ${r.status}`;
    } catch (e) {
      detail = e.name === 'TimeoutError' ? 'timed out' : 'unreachable';
    }
    const ms = Date.now() - t0;
    await env.DB.prepare(
      `INSERT INTO probes (component, at, state, ms, detail) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (component) DO UPDATE SET at = excluded.at, state = excluded.state, ms = excluded.ms, detail = excluded.detail`
    )
      .bind(p.id, at, state, ms, detail)
      .run();
    await tally(env.DB, p.id, state, at);
  }
  const last = await env.DB.prepare('SELECT at FROM reports WHERE id = 1').first();
  if (!last || at - last.at > STALE_MS) await tally(env.DB, 'box', 'down', at);
}

async function report(request, env) {
  if (!(await authorized(request, env.REPORT_TOKEN))) return json({ error: 'unauthorized' }, 401);
  const body = await request.json();
  if (!Array.isArray(body.components)) return json({ error: 'components must be a list' }, 400);
  const at = Date.now();
  await env.DB.prepare(
    `INSERT INTO reports (id, at, body) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, body = excluded.body`
  )
    .bind(at, JSON.stringify(body))
    .run();
  for (const c of body.components) if (c.state !== 'idle' && c.state !== 'unknown') await tally(env.DB, c.id, c.state, at);
  await tally(env.DB, 'box', 'ok', at);
  return json({ ok: true });
}

async function incident(request, env, id) {
  if (!(await authorized(request, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401);
  const b = await request.json();
  const now = Date.now();
  const status = b.status || 'investigating';
  if (!INCIDENT_STATES.includes(status)) return json({ error: `status is one of ${INCIDENT_STATES}` }, 400);
  if (!b.body) return json({ error: 'body is required' }, 400);
  if (!id) {
    const impact = b.impact || 'minor';
    if (!b.title || !IMPACTS.includes(impact)) return json({ error: `title and impact (${IMPACTS}) are required` }, 400);
    const row = await env.DB.prepare(
      'INSERT INTO incidents (title, status, impact, affects, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
    )
      .bind(b.title, status, impact, (b.affects || []).join(','), now)
      .first();
    id = row.id;
  } else {
    const found = await env.DB.prepare('SELECT id FROM incidents WHERE id = ?').bind(id).first();
    if (!found) return json({ error: 'no such incident' }, 404);
    await env.DB.prepare('UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?')
      .bind(status, status === 'resolved' ? now : null, id)
      .run();
  }
  await env.DB.prepare('INSERT INTO updates (incident_id, at, status, body) VALUES (?, ?, ?, ?)')
    .bind(id, now, status, b.body)
    .run();
  return json({ ok: true, id });
}

async function status(env) {
  const now = Date.now();
  const last = await env.DB.prepare('SELECT at, body FROM reports WHERE id = 1').first();
  const stale = !last || now - last.at > STALE_MS;
  const boxed = last ? JSON.parse(last.body) : { components: [] };
  const probes = (await env.DB.prepare('SELECT * FROM probes').all()).results;
  const since = day(now - 89 * 86400000);
  const days = (await env.DB.prepare('SELECT * FROM daily WHERE day >= ? ORDER BY day').bind(since).all()).results;
  const incidents = (
    await env.DB.prepare('SELECT * FROM incidents WHERE resolved_at IS NULL OR resolved_at > ? ORDER BY created_at DESC')
      .bind(now - 30 * 86400000)
      .all()
  ).results;
  const updates = incidents.length
    ? (
        await env.DB.prepare(
          `SELECT * FROM updates WHERE incident_id IN (${incidents.map(() => '?').join(',')}) ORDER BY at DESC`
        )
          .bind(...incidents.map(i => i.id))
          .all()
      ).results
    : [];
  const components = [
    ...probes.map(p => ({ id: p.component, group: 'gronka', state: p.state, at: p.at, ms: p.ms, detail: p.detail })),
    ...boxed.components.map(c => ({ ...c, at: last.at, state: stale ? 'unknown' : c.state })),
  ];
  return json({
    now,
    box: { at: last?.at ?? null, stale, version: boxed.version ?? null },
    components,
    days,
    incidents: incidents.map(i => ({ ...i, updates: updates.filter(u => u.incident_id === i.id) })),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const incidentPath = url.pathname.match(/^\/api\/incidents(?:\/(\d+))?$/);
    if (url.pathname === '/api/status' && request.method === 'GET') return status(env);
    if (url.pathname === '/api/report' && request.method === 'POST') return report(request, env);
    if (incidentPath && request.method === 'POST') return incident(request, env, incidentPath[1] && Number(incidentPath[1]));
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env) {
    await probe(env);
  },
};
