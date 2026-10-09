'use strict';

/*
 * Minimal JKS (Java KeyStore) reader — pure JS, no deps, no `keytool`.
 *
 * It reads the certificates out of a .jks file and reports each entry's alias,
 * type and the cert expiry. Reading trusted certs and cert chains needs NO
 * password (only private-key material is encrypted, and we skip that), so the
 * monitor can inspect a mounted truststore read-only and safely.
 *
 * JKS layout:
 *   magic   0xFEEDFEED (4 bytes)
 *   version int (4)                       -- 1 or 2
 *   count   int (4)
 *   entries:
 *     tag   int (4)                        -- 1 = privateKey, 2 = trustedCert
 *     alias UTF (2-byte len + bytes)
 *     ts    long (8)
 *     if tag==2 (trustedCert):
 *       [version 2 only] certType UTF
 *       certLen int (4); certDER bytes
 *     if tag==1 (privateKey):
 *       keyLen int (4); key bytes (skipped)
 *       chainLen int (4)
 *       per chain cert: [v2] certType UTF; certLen int; certDER bytes
 *   trailing SHA-1 digest (ignored)
 */

const fs = require('fs');
const { X509Certificate } = require('crypto');

function daysUntil(dateStr) {
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86400000);
}

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  int() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  long() { const v = Number(this.b.readBigInt64BE(this.o)); this.o += 8; return v; }
  utf() { const n = this.b.readUInt16BE(this.o); this.o += 2; const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
}

function certInfo(der) {
  try {
    const cert = new X509Certificate(der);
    const days = daysUntil(cert.validTo);
    return {
      subject: cert.subject.replace(/\n/g, ', '),
      issuer: cert.issuer.replace(/\n/g, ', '),
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      daysRemaining: days,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * @returns {{ ok:boolean, path:string, version?:number, entries?:Array, error?:string }}
 */
function readJks(path) {
  let buf;
  try {
    buf = fs.readFileSync(path);
  } catch (err) {
    return { ok: false, path, error: err.message };
  }
  try {
    const r = new Reader(buf);
    const magic = r.int() >>> 0;
    if (magic !== 0xfeedfeed) {
      return { ok: false, path, error: `not a JKS file (magic ${magic.toString(16)})` };
    }
    const version = r.int();
    const count = r.int();
    const entries = [];
    for (let i = 0; i < count; i++) {
      const tag = r.int();
      const alias = r.utf();
      r.long(); // creation timestamp, unused
      if (tag === 2) {
        if (version === 2) r.utf(); // certType
        const len = r.int();
        const der = r.bytes(len);
        entries.push({ alias, type: 'trustedCert', certs: [certInfo(der)] });
      } else if (tag === 1) {
        const keyLen = r.int();
        r.bytes(keyLen); // encrypted key, skipped
        const chainLen = r.int();
        const certs = [];
        for (let c = 0; c < chainLen; c++) {
          if (version === 2) r.utf();
          const len = r.int();
          certs.push(certInfo(r.bytes(len)));
        }
        entries.push({ alias, type: 'privateKeyEntry', certs });
      } else {
        return { ok: false, path, error: `unknown entry tag ${tag} at #${i}` };
      }
    }
    return { ok: true, path, version, entries };
  } catch (err) {
    return { ok: false, path, error: `parse error: ${err.message}` };
  }
}

/** Summarise a truststore for the UI: worst status + per-entry expiry. */
function summariseTruststore(path, thresholds) {
  const { warnDays = 30, criticalDays = 7 } = thresholds || {};
  const res = readJks(path);
  if (!res.ok) return { file: path.split('/').pop(), status: 'unknown', error: res.error };

  const order = ['expired', 'critical', 'warning', 'ok'];
  let worst = 'ok';
  const flat = [];
  for (const e of res.entries) {
    for (const c of e.certs) {
      let s = 'unknown';
      if (!c.error) {
        const d = c.daysRemaining;
        s = d < 0 ? 'expired' : d <= criticalDays ? 'critical' : d <= warnDays ? 'warning' : 'ok';
      }
      if (order.indexOf(s) < order.indexOf(worst) || worst === 'ok' && s !== 'ok') {
        // pick the most severe
      }
      if (order.indexOf(s) !== -1 && (order.indexOf(s) < order.indexOf(worst))) worst = s;
      flat.push({ alias: e.alias, type: e.type, cn: cn(c.subject), validTo: c.validTo, daysRemaining: c.daysRemaining, error: c.error });
    }
  }
  return { file: path.split('/').pop(), path, status: worst, count: flat.length, entries: flat };
}

function cn(subject) {
  if (!subject) return '';
  const m = /CN=([^,]+)/.exec(subject);
  return m ? m[1] : subject;
}

module.exports = { readJks, summariseTruststore };
