'use strict';

/*
 * Configuration loader.
 *
 * Targets are read, in priority order, from:
 *   1. The file named by MONITOR_CONFIG (default: ./config.json), if it exists.
 *   2. The built-in defaults below.
 *
 * Nothing secret lives here. The monitor only needs hostnames, ports and
 * (optionally) paths to PEM files it may read for a "bundled cert" check.
 * It never needs the AES keys, the API keys or the Oracle DB password.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // How often the browser UI auto-refreshes, in seconds.
  refreshSeconds: 300,
  // A cert with fewer than this many days left is shown amber.
  warnDays: 30,
  // A cert with fewer than this many days left is shown red.
  criticalDays: 7,
  // Optional SMTP alerting. Disabled unless alert.enabled is true AND
  // the SMTP_* environment variables are provided (see README).
  alert: {
    enabled: false,
    // Re-send an alert for the same target at most once per this many hours.
    throttleHours: 12,
  },
  targets: [
    {
      name: 'SMSGateway (AWS)',
      // The host whose live TLS cert we probe. Override via env for prod.
      host: 'ndbsms-uat.ndblk.int',
      port: 443,
      // SNI server name sent in the TLS handshake. Defaults to host.
      servername: 'ndbsms-uat.ndblk.int',
      // Health endpoint. type 'http'|'https'|'tcp'. 'none' skips health.
      health: { type: 'https', port: 443, path: '/SMSGateway/actuator/health' },
      // Optional: PEM file(s) mounted into the monitor to report bundled expiry.
      bundledCerts: [],
    },
    {
      name: 'NDBSMSRouter (K8s)',
      host: 'ndbsmsrouter.ndblk.int',
      port: 8085,
      servername: 'ndbsmsrouter.ndblk.int',
      health: { type: 'http', port: 8085, path: '/actuator/health' },
      bundledCerts: [],
    },
  ],
};

function loadConfig() {
  const configPath = process.env.MONITOR_CONFIG || path.join(process.cwd(), 'config.json');
  let cfg = DEFAULTS;
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      cfg = mergeConfig(DEFAULTS, parsed);
      cfg._source = configPath;
    } else {
      cfg = { ...DEFAULTS, _source: 'built-in defaults' };
    }
  } catch (err) {
    // Never crash on a bad config file — fall back to defaults and surface it.
    cfg = { ...DEFAULTS, _source: `built-in defaults (config error: ${err.message})` };
  }

  // Light env overrides, handy for quick prod wiring without a config file.
  if (process.env.REFRESH_SECONDS) cfg.refreshSeconds = Number(process.env.REFRESH_SECONDS);
  if (process.env.WARN_DAYS) cfg.warnDays = Number(process.env.WARN_DAYS);
  if (process.env.CRITICAL_DAYS) cfg.criticalDays = Number(process.env.CRITICAL_DAYS);
  if (process.env.ALERT_ENABLED) cfg.alert.enabled = process.env.ALERT_ENABLED === 'true';

  return cfg;
}

function mergeConfig(base, override) {
  const out = { ...base, ...override };
  out.alert = { ...base.alert, ...(override.alert || {}) };
  // If the override supplies targets, they fully replace the defaults.
  out.targets = Array.isArray(override.targets) && override.targets.length
    ? override.targets
    : base.targets;
  return out;
}

module.exports = { loadConfig, DEFAULTS };
