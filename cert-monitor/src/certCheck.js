'use strict';

/*
 * Certificate checks.
 *
 * Two independent mechanisms:
 *
 *  1. probeLiveCert(target) — opens a real TLS connection and reads the
 *     certificate the server actually presents. This is the authoritative
 *     check: it tells you what clients (Dialog, NDBSMSRouter) actually see.
 *     We set rejectUnauthorized:false so we can still READ and report an
 *     expired/untrusted cert instead of just erroring out — but we record
 *     whether the chain WOULD have validated (`authorized`).
 *
 *  2. readBundledCert(pemPath) — reads a PEM file mounted into the monitor
 *     and reports its expiry. Useful to catch drift between the cert bundled
 *     in a truststore and the cert actually served.
 */

const tls = require('tls');
const fs = require('fs');
const { X509Certificate } = require('crypto');

const DEFAULT_TIMEOUT_MS = 8000;

function daysUntil(dateStr) {
  const expiry = new Date(dateStr).getTime();
  if (Number.isNaN(expiry)) return null;
  return Math.floor((expiry - Date.now()) / (1000 * 60 * 60 * 24));
}

function classify(days, warnDays, criticalDays) {
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= criticalDays) return 'critical';
  if (days <= warnDays) return 'warning';
  return 'ok';
}

function probeLiveCert(target, thresholds) {
  const { warnDays = 30, criticalDays = 7 } = thresholds || {};
  const host = target.host;
  const port = target.port || 443;
  const servername = target.servername || host;

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) { /* noop */ }
      resolve(result);
    };

    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false,      // read the cert even if the chain is bad
      timeout: DEFAULT_TIMEOUT_MS,
    }, () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert || Object.keys(cert).length === 0) {
        return done({ reachable: true, status: 'unknown', error: 'no peer certificate returned' });
      }
      const days = daysUntil(cert.valid_to);
      done({
        reachable: true,
        status: classify(days, warnDays, criticalDays),
        subject: cert.subject && cert.subject.CN ? cert.subject.CN : stringifyName(cert.subject),
        issuer: cert.issuer && cert.issuer.CN ? cert.issuer.CN : stringifyName(cert.issuer),
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        daysRemaining: days,
        authorized: socket.authorized,
        authorizationError: socket.authorized ? null : String(socket.authorizationError || 'chain not trusted'),
        chain: buildChainSummary(cert),
        latencyMs: Date.now() - started,
      });
    });

    socket.on('error', (err) => {
      done({ reachable: false, status: 'unreachable', error: err.message, latencyMs: Date.now() - started });
    });
    socket.on('timeout', () => {
      done({ reachable: false, status: 'unreachable', error: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, latencyMs: Date.now() - started });
    });
  });
}

function buildChainSummary(leaf) {
  const chain = [];
  const seen = new Set();
  let node = leaf;
  while (node && !seen.has(node.fingerprint256)) {
    seen.add(node.fingerprint256);
    chain.push({
      subject: node.subject && node.subject.CN ? node.subject.CN : stringifyName(node.subject),
      validTo: node.valid_to,
      daysRemaining: daysUntil(node.valid_to),
    });
    node = node.issuerCertificate && node.issuerCertificate !== node ? node.issuerCertificate : null;
  }
  return chain;
}

function stringifyName(name) {
  if (!name) return '(unknown)';
  if (typeof name === 'string') return name;
  return Object.entries(name).map(([k, v]) => `${k}=${v}`).join(', ');
}

function readBundledCert(pemPath, thresholds) {
  const { warnDays = 30, criticalDays = 7 } = thresholds || {};
  try {
    const pem = fs.readFileSync(pemPath, 'utf8');
    const cert = new X509Certificate(pem);
    const days = daysUntil(cert.validTo);
    return {
      file: pemPath,
      status: classify(days, warnDays, criticalDays),
      subject: cert.subject,
      issuer: cert.issuer,
      validTo: cert.validTo,
      daysRemaining: days,
    };
  } catch (err) {
    return { file: pemPath, status: 'unknown', error: err.message };
  }
}

module.exports = { probeLiveCert, readBundledCert, daysUntil, classify };
