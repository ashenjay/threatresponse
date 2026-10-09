'use strict';

/*
 * SMS Services monitor — pure-Node HTTP server (no web framework).
 *
 * Routes:
 *   GET /            -> dashboard UI (public/index.html)
 *   GET /api/status  -> JSON snapshot of all targets (cert + health)
 *   GET /healthz     -> liveness for the monitor itself (always 200 if up)
 *
 * Results are cached and refreshed on an interval so the UI and any external
 * poller are cheap; a cache-busting ?fresh=1 forces an immediate re-check.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config');
const { probeLiveCert, readBundledCert } = require('./certCheck');
const { checkHealth } = require('./healthCheck');
const { sendAlerts } = require('./alert');

const cfg = loadConfig();
const PORT = Number(process.env.PORT || 8080);

let snapshot = { generatedAt: null, targets: [] };
let refreshing = false;

async function refresh() {
  if (refreshing) return snapshot;
  refreshing = true;
  const thresholds = { warnDays: cfg.warnDays, criticalDays: cfg.criticalDays };
  try {
    const results = await Promise.all(cfg.targets.map(async (t) => {
      const [cert, health] = await Promise.all([
        probeLiveCert(t, thresholds),
        checkHealth(t),
      ]);
      const bundled = (t.bundledCerts || []).map((p) => readBundledCert(p, thresholds));
      return { name: t.name, host: t.host, port: t.port, cert, health, bundled };
    }));

    snapshot = { generatedAt: new Date().toISOString(), warnDays: cfg.warnDays, criticalDays: cfg.criticalDays, targets: results };

    // Collect alert-worthy problems.
    const problems = [];
    for (const r of results) {
      if (['expired', 'critical'].includes(r.cert.status)) {
        problems.push({
          key: `cert:${r.name}`,
          subject: `${r.name} cert ${r.cert.status} (${r.cert.daysRemaining}d)`,
          body: `${r.host}:${r.port} serves cert CN=${r.cert.subject || '?'} expiring ${r.cert.validTo} (${r.cert.daysRemaining} days left).`,
        });
      }
      if (r.health && r.health.status === 'down') {
        problems.push({
          key: `health:${r.name}`,
          subject: `${r.name} is DOWN`,
          body: `${r.host} health check failed: ${r.health.error || 'no response'}.`,
        });
      }
    }
    await sendAlerts(problems, cfg.alert);
  } finally {
    refreshing = false;
  }
  return snapshot;
}

function serveStatic(res) {
  const file = path.join(__dirname, '..', 'public', 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('UI not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok', uptimeSec: Math.round(process.uptime()) });
  if (url.pathname === '/api/status') {
    if (url.searchParams.get('fresh') === '1' || !snapshot.generatedAt) await refresh();
    return sendJson(res, 200, { ...snapshot, config: { refreshSeconds: cfg.refreshSeconds, source: cfg._source } });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[sms-monitor] listening on :${PORT} (config: ${cfg._source})`);
  console.log(`[sms-monitor] monitoring ${cfg.targets.length} target(s); refresh every ${cfg.refreshSeconds}s`);
  refresh().catch((e) => console.error('[sms-monitor] initial refresh failed:', e.message));
  setInterval(() => refresh().catch((e) => console.error('[sms-monitor] refresh failed:', e.message)), cfg.refreshSeconds * 1000);
});
