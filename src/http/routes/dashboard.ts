import type { FastifyInstance } from "fastify";

/**
 * A single-page log viewer.
 *
 * Served as one inline HTML string with no build step, no framework, and no new
 * dependency. That is deliberate: a dashboard is a stretch goal, and a stretch
 * goal that adds a bundler to the image would cost more than it is worth
 * against a 256 MB budget.
 *
 * It consumes the public API — GET /logs, GET /logs/aggregate, GET /metrics —
 * from the browser. So it exercises the same contract the load generator does,
 * and adds no server-side query path that could diverge from it.
 */

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log Service</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --border: #262b36;
    --text: #e6e8eb;
    --muted: #8b93a1;
    --accent: #6aa9ff;
    --error: #ff6b6b;
    --warn: #ffb454;
    --info: #6aa9ff;
    --debug: #8b93a1;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 16px;
  }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; }
  main { padding: 20px; max-width: 1400px; }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
  }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 22px; margin-top: 4px; }
  .card .unit { color: var(--muted); font-size: 12px; }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }
  input, select, button {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    padding: 7px 10px;
    font: inherit;
  }
  button { cursor: pointer; border-color: var(--accent); color: var(--accent); }
  button:hover { background: #1d2530; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .04em;
    padding: 8px;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: var(--panel); }
  .lvl { font-weight: 600; }
  .lvl-error { color: var(--error); }
  .lvl-warn { color: var(--warn); }
  .lvl-info { color: var(--info); }
  .lvl-debug { color: var(--debug); }
  .ts { color: var(--muted); white-space: nowrap; }
  .attrs { color: var(--muted); font-size: 12px; }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 60px; margin-bottom: 20px; }
  .bar { flex: 1; background: var(--accent); opacity: .7; min-height: 1px; border-radius: 1px 1px 0 0; }
  .bar:hover { opacity: 1; }
  .empty, .err { color: var(--muted); padding: 20px 8px; }
  .err { color: var(--error); }
</style>
</head>
<body>
<header>
  <h1>Log Service</h1>
  <span class="sub" id="status">loading…</span>
</header>

<main>
  <div class="cards" id="cards"></div>
  <div class="bars" id="bars" title="Log volume, last hour by minute"></div>

  <div class="filters">
    <input id="f-service" placeholder="service" size="14">
    <select id="f-level">
      <option value="">any level</option>
      <option>debug</option><option>info</option>
      <option>warn</option><option>error</option>
    </select>
    <input id="f-q" placeholder="message contains" size="20">
    <input id="f-attr" placeholder="attr.key=value" size="18">
    <button id="apply">Search</button>
    <button id="auto">Auto-refresh: off</button>
  </div>

  <table>
    <thead><tr><th>Time</th><th>Level</th><th>Service</th><th>Message</th><th>Attributes</th></tr></thead>
    <tbody id="rows"><tr><td colspan="5" class="empty">loading…</td></tr></tbody>
  </table>
</main>

<script>
const $ = (id) => document.getElementById(id);
let timer = null;

function card(label, value, unit) {
  return '<div class="card"><div class="label">' + label + '</div>' +
         '<div class="value">' + value +
         (unit ? ' <span class="unit">' + unit + '</span>' : '') + '</div></div>';
}

async function loadMetrics() {
  try {
    const m = await (await fetch('/metrics')).json();

    $('cards').innerHTML =
      card('Ingested', m.ingestion.logs_accepted.toLocaleString()) +
      card('Rate', m.ingestion.logs_per_second.toLocaleString(), 'logs/s') +
      card('Ingest p95', m.ingestion.latency_ms.p95, 'ms') +
      card('Rejected', m.ingestion.logs_rejected.toLocaleString()) +
      card('Aggregates', m.aggregations.requests.toLocaleString()) +
      card('From rollup', m.aggregations.served_from_rollup.toLocaleString()) +
      card('Aggregate p95', m.aggregations.latency_ms.p95, 'ms') +
      card('Heap', m.memory.heap_used_mb, 'MB');

    $('status').textContent = 'up ' + m.uptime_seconds + 's';
  } catch (e) {
    $('status').textContent = 'metrics unavailable';
  }
}

async function loadChart() {
  // Bounds are aligned to the minute so the aggregate is served from the
  // rollup rather than falling back to a raw scan.
  const now = Date.now();
  const until = new Date(Math.ceil(now / 60000) * 60000);
  const since = new Date(until.getTime() - 60 * 60000);

  try {
    const url = '/logs/aggregate?since=' + since.toISOString() +
                '&until=' + until.toISOString() + '&bucket=1m';
    const data = await (await fetch(url)).json();

    const counts = new Map(
      data.buckets.map((b) => [new Date(b.start).getTime(), b.count]),
    );
    const max = Math.max(1, ...counts.values());

    let html = '';
    for (let i = 59; i >= 0; i -= 1) {
      const t = until.getTime() - i * 60000;
      const c = counts.get(t) || 0;
      const h = Math.round((c / max) * 100);
      html += '<div class="bar" style="height:' + h + '%" title="' +
              new Date(t).toISOString().slice(11, 16) + ' — ' +
              c.toLocaleString() + '"></div>';
    }
    $('bars').innerHTML = html;
  } catch (e) {
    $('bars').innerHTML = '';
  }
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

async function loadLogs() {
  const params = new URLSearchParams({ limit: '100' });

  const service = $('f-service').value.trim();
  const level = $('f-level').value;
  const q = $('f-q').value.trim();
  const attr = $('f-attr').value.trim();

  if (service) params.set('service', service);
  if (level) params.set('level', level);
  if (q) params.set('q', q);

  if (attr.includes('=')) {
    const [k, ...rest] = attr.split('=');
    params.set('attr.' + k.replace(/^attr\\./, ''), rest.join('='));
  }

  try {
    const res = await fetch('/logs?' + params);
    const data = await res.json();

    if (!res.ok) {
      $('rows').innerHTML = '<tr><td colspan="5" class="err">' +
        escape(data.error || 'request failed') + '</td></tr>';
      return;
    }

    if (data.logs.length === 0) {
      $('rows').innerHTML = '<tr><td colspan="5" class="empty">no logs match</td></tr>';
      return;
    }

    $('rows').innerHTML = data.logs.map((l) =>
      '<tr><td class="ts">' + l.timestamp.replace('T', ' ').slice(0, 23) + '</td>' +
      '<td class="lvl lvl-' + l.level + '">' + l.level + '</td>' +
      '<td>' + escape(l.service) + '</td>' +
      '<td>' + escape(l.message) + '</td>' +
      '<td class="attrs">' + escape(
        Object.entries(l.attributes || {}).map(([k, v]) => k + '=' + v).join(' ')
      ) + '</td></tr>'
    ).join('');
  } catch (e) {
    $('rows').innerHTML = '<tr><td colspan="5" class="err">request failed</td></tr>';
  }
}

function refresh() {
  loadMetrics();
  loadChart();
  loadLogs();
}

$('apply').onclick = refresh;

$('auto').onclick = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    $('auto').textContent = 'Auto-refresh: off';
  } else {
    timer = setInterval(refresh, 5000);
    $('auto').textContent = 'Auto-refresh: 5s';
  }
};

for (const id of ['f-service', 'f-q', 'f-attr']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });
}

refresh();
</script>
</body>
</html>`;

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get("/dashboard", (_request, reply) => {
    return reply.type("text/html; charset=utf-8").code(200).send(DASHBOARD_HTML);
  });
}
