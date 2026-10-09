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
const { summariseTruststore } = require('./jks');
const { sendAlerts } = require('./alert');

const cfg = loadConfig();
const PORT = Number(process.env.PORT || 8080);

function statusOf(days, c) {
  if (days === null || days === undefined) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= c.criticalDays) return 'critical';
  if (days <= c.warnDays) return 'warning';
  return 'ok';
}

let snapshot = { generatedAt: null, targets: [] };
let refreshing = false;

async function refresh() {
  if (refreshing) return snapshot;
  refreshing = true;
  const thresholds = { warnDays: cfg.warnDays, criticalDays: cfg.criticalDays };
  try {
    const results = await Promise.all(cfg.targets.map(async (t) => {
      const [cert, health, upstream] = await Promise.all([
        probeLiveCert(t, thresholds),
        checkHealth(t),
        t.upstream ? probeLiveCert(t.upstream, thresholds) : Promise.resolve(null),
      ]);
      const bundled = (t.bundledCerts || []).map((p) => readBundledCert(p, thresholds));
      const truststore = t.truststore ? summariseTruststore(t.truststore, thresholds) : null;
      return {
        name: t.name, role: t.role || 'internal', platform: t.platform || null,
        host: t.host, port: t.port,
        cert, health, bundled, truststore,
        upstream: upstream ? { name: t.upstream.name, host: t.upstream.host, port: t.upstream.port, cert: upstream } : null,
      };
    }));

    snapshot = { generatedAt: new Date().toISOString(), profile: cfg.profile, warnDays: cfg.warnDays, criticalDays: cfg.criticalDays, targets: results };

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
      // Truststore entries nearing expiry (e.g. the Dialog leaf in the gateway JKS).
      if (r.truststore && r.truststore.entries) {
        for (const e of r.truststore.entries) {
          if (['expired', 'critical'].includes(statusOf(e.daysRemaining, cfg))) {
            problems.push({
              key: `jks:${r.name}:${e.alias}`,
              subject: `${r.name} truststore '${e.alias}' (${e.cn}) ${e.daysRemaining}d`,
              body: `JKS ${r.truststore.file} alias '${e.alias}' CN=${e.cn} expires ${e.validTo} (${e.daysRemaining} days). Rotate per runbook — no image rebuild needed.`,
            });
          }
        }
      }
      // Upstream (Dialog) cert the gateway must trust.
      if (r.upstream && r.upstream.cert && ['expired', 'critical'].includes(r.upstream.cert.status)) {
        problems.push({
          key: `upstream:${r.name}`,
          subject: `${r.upstream.name} cert ${r.upstream.cert.status} (${r.upstream.cert.daysRemaining}d)`,
          body: `${r.upstream.host} serves a cert expiring ${r.upstream.cert.validTo}. Ensure the matching leaf is in ${r.name}'s truststore.`,
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
