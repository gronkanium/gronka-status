#!/usr/bin/env bun
// Runs on the gronka box. `collect` gathers what only the box can see and posts it to the status
// Worker; `incident` writes incident reports. Only counts and states leave the box: no urls, no ids.
import { parseArgs } from 'node:util';

const STATUS_URL = process.env.STATUS_URL || 'https://status.gronka.dev';
const SESSIONS_URL = process.env.SESSIONS_URL;
const WORKERS_EXPECTED = Number(process.env.WORKERS_EXPECTED || 2);
const WINDOW_HOURS = 3;

const SOURCES = {
  youtube: ['youtube.com', 'youtu.be', 'music.youtube.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
  x: ['x.com', 'twitter.com'],
  reddit: ['reddit.com', 'redd.it', 'old.reddit.com'],
  pinterest: ['pinterest.com', 'pin.it'],
  bluesky: ['bsky.app'],
  soundcloud: ['soundcloud.com'],
  facebook: ['facebook.com', 'fb.watch'],
  twitch: ['twitch.tv', 'clips.twitch.tv'],
};
const LABELS = { x: 'x / twitter' };

async function sh(cmd) {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

const sql = q => sh(['docker', 'exec', 'gronka-postgres', 'psql', '-U', 'gronka', '-d', 'gronka', '-AtF', '\t', '-c', q]);

function sourceOf(host) {
  host = host.replace(/^(www|m|vm|vt|mobile)\./, '');
  for (const [id, hosts] of Object.entries(SOURCES)) if (hosts.some(h => host === h || host.endsWith(`.${h}`))) return id;
  return null;
}

async function bot() {
  const health = await sh(['docker', 'inspect', '-f', '{{.State.Health.Status}}', 'gronka']).catch(() => 'missing');
  const rows = await sql(
    `select role, version, (extract(epoch from now())*1000 - seen_at)::bigint from media_workers where seen_at > extract(epoch from now())*1000 - 90000`
  );
  const live = rows ? rows.split('\n').map(r => r.split('\t')) : [];
  const bots = live.filter(r => r[0] === 'bot');
  const workers = live.filter(r => r[0] === 'worker').length;
  const version = bots[0]?.[1] ?? null;
  return {
    version,
    components: [
      {
        id: 'bot',
        group: 'gronka',
        state: health === 'healthy' && bots.length ? 'ok' : health === 'starting' ? 'degraded' : 'down',
        detail: health === 'healthy' ? (version ? `v${version}` : '') : `container ${health}`,
      },
      {
        id: 'workers',
        group: 'gronka',
        state: workers >= WORKERS_EXPECTED ? 'ok' : workers ? 'degraded' : 'down',
        detail: `${workers} of ${WORKERS_EXPECTED} online`,
      },
    ],
  };
}

async function sources() {
  const since = `extract(epoch from now())*1000 - ${WINDOW_HOURS * 3600000}`;
  const rows = await sql(`
    with c as (
      select operation_id, metadata::jsonb->>'originalUrl' u from operation_logs
      where step = 'created' and timestamp > ${since} and metadata::jsonb ? 'originalUrl'
    ), f as (
      select distinct on (operation_id) operation_id, metadata::jsonb->>'newStatus' s from operation_logs
      where step = 'status_update' and timestamp > ${since} and metadata::jsonb->>'newStatus' in ('success', 'error')
      order by operation_id, id desc
    )
    select lower(substring(u from '^https?://([^/:?#]+)')), count(*) filter (where s = 'success'), count(*) filter (where s = 'error')
    from c join f using (operation_id) group by 1`);
  const tally = Object.fromEntries(Object.keys(SOURCES).map(id => [id, { ok: 0, err: 0 }]));
  for (const line of rows ? rows.split('\n') : []) {
    const [host, ok, err] = line.split('\t');
    const id = sourceOf(host || '');
    if (id) (tally[id].ok += Number(ok)), (tally[id].err += Number(err));
  }
  return Object.entries(tally).map(([id, { ok, err }]) => {
    const n = ok + err;
    const rate = n ? ok / n : null;
    const state = !n ? 'idle' : err >= 3 && !ok ? 'down' : n >= 3 && rate < 0.9 ? 'degraded' : 'ok';
    return {
      id,
      group: 'sources',
      label: LABELS[id] ?? id,
      state,
      detail: n ? `${Math.round(rate * 100)}% of ${n} in ${WINDOW_HOURS}h` : `no requests in ${WINDOW_HOURS}h`,
    };
  });
}

async function sessions() {
  if (!SESSIONS_URL) return [];
  try {
    const r = await fetch(SESSIONS_URL, { signal: AbortSignal.timeout(5000) });
    const { sessions: list } = await r.json();
    return list.map(s => ({
      id: `session-${s.id}`,
      group: 'sessions',
      label: `${s.name.toLowerCase()} session`,
      // 'running' is a routine login check in progress, not a problem.
      state:
        s.status === 'alive' || s.status === 'running'
          ? 'ok'
          : s.backoff || s.status === 'failing' || s.status === 'backing off'
            ? 'down'
            : 'unknown',
      detail:
        s.status === 'running'
          ? 'checking now'
          : s.lastCheck
            ? `checked ${Math.round((Date.now() - s.lastCheck) / 60000)} min ago`
            : 'never checked',
    }));
  } catch {
    return [
      { id: 'session-instagram', group: 'sessions', label: 'instagram session', state: 'unknown', detail: 'no answer' },
      { id: 'session-youtube', group: 'sessions', label: 'youtube session', state: 'unknown', detail: 'no answer' },
    ];
  }
}

async function collect(dryRun) {
  const b = await bot();
  const body = { version: b.version, components: [...b.components, ...(await sessions()), ...(await sources())] };
  if (dryRun) return console.log(JSON.stringify(body, null, 2));
  const r = await fetch(`${STATUS_URL}/api/report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STATUS_REPORT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`report rejected: ${r.status} ${await r.text()}`);
}

async function incident(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      status: { type: 'string' },
      impact: { type: 'string' },
      affects: { type: 'string' },
    },
  });
  const [action, idOrBody, maybeBody] = positionals;
  const id = action === 'new' ? null : idOrBody;
  const body = action === 'new' ? idOrBody : maybeBody;
  if (!['new', 'update', 'resolve'].includes(action) || !body || (action !== 'new' && !id)) {
    console.error(`usage:
  status incident new "what users see" --title "instagram downloads failing" [--impact minor|major|maintenance] [--affects instagram,web]
  status incident update <id> "what changed" [--status identified|monitoring]
  status incident resolve <id> "what fixed it"`);
    process.exit(2);
  }
  const payload = {
    body,
    title: values.title,
    impact: values.impact,
    affects: values.affects?.split(',').map(s => s.trim()),
    status: action === 'resolve' ? 'resolved' : values.status,
  };
  const r = await fetch(`${STATUS_URL}/api/incidents${id ? `/${id}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STATUS_ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error);
  console.log(action === 'new' ? `incident ${out.id} posted` : `incident ${out.id} ${payload.status || 'updated'}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'collect') await collect(rest.includes('--dry-run'));
else if (cmd === 'incident') await incident(rest);
else {
  console.error('usage: status collect [--dry-run] | status incident new|update|resolve ...');
  process.exit(2);
}
