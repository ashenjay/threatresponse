'use strict';

/*
 * Service health checks. Supports:
 *   - http / https : GET the given path, report status code + latency.
 *                    2xx/3xx => up. Anything else => degraded (still reachable).
 *   - tcp          : just open a socket. Connect ok => up.
 *   - none         : skip (returns status 'skipped').
 *
 * For https we do NOT validate the chain here (rejectUnauthorized:false):
 * cert trust is reported separately by certCheck. A health check should tell
 * you "is the app answering", not fail because a cert is expiring.
 */

const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULT_TIMEOUT_MS = 8000;

function checkHealth(target) {
  const h = target.health || { type: 'none' };
  if (!h.type || h.type === 'none') {
    return Promise.resolve({ status: 'skipped' });
  }
  if (h.type === 'tcp') return checkTcp(target.host, h.port || target.port);
  return checkHttp(target.host, h);
}

function checkHttp(host, h) {
  const lib = h.type === 'https' ? https : http;
  const started = Date.now();
  return new Promise((resolve) => {
    const req = lib.request({
      host,
      port: h.port || (h.type === 'https' ? 443 : 80),
      path: h.path || '/',
      method: 'GET',
      timeout: DEFAULT_TIMEOUT_MS,
      rejectUnauthorized: false,
      servername: h.servername || host,
    }, (res) => {
      // Drain and discard the body; we only care about the status code.
      res.resume();
      const up = res.statusCode >= 200 && res.statusCode < 400;
      resolve({
        status: up ? 'up' : 'degraded',
        httpStatus: res.statusCode,
        latencyMs: Date.now() - started,
      });
    });
    req.on('error', (err) => resolve({ status: 'down', error: err.message, latencyMs: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', error: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, latencyMs: Date.now() - started }); });
    req.end();
  });
}

function checkTcp(host, port) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: DEFAULT_TIMEOUT_MS }, () => {
      socket.destroy();
      resolve({ status: 'up', latencyMs: Date.now() - started });
    });
    socket.on('error', (err) => resolve({ status: 'down', error: err.message, latencyMs: Date.now() - started }));
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'down', error: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, latencyMs: Date.now() - started }); });
  });
}

module.exports = { checkHealth };
