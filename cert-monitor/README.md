# cert-monitor

A tiny Node.js service that watches the NDB SMS services and shows, per
service, in a web dashboard:

- **Live TLS certificate** status — the cert the server actually serves: CN,
  issuer, expiry date, days remaining, whether the chain is trusted, and the
  full chain with each link's days-remaining.
- **Service health** — HTTP/HTTPS/TCP probe: up / degraded / down + latency.
- Optional **bundled cert** check — reads a mounted PEM and reports its expiry
  (to catch drift between a bundled cert and the served one).
- Optional **email alerts** on cert-critical / service-down.

It is **read-only** — it never changes the services. Zero required runtime
dependencies (pure Node `tls`/`http`/`crypto`); `nodemailer` is optional and
only used if alerts are enabled.

## Run locally

```bash
cd cert-monitor
cp config.example.json config.json   # edit hosts/ports
node src/server.js                   # -> http://localhost:8080
```

Endpoints:
- `GET /` — dashboard
- `GET /api/status` — JSON snapshot (`?fresh=1` forces an immediate re-check)
- `GET /healthz` — monitor's own liveness

## Configure

Config is read from `MONITOR_CONFIG` (default `./config.json`); if absent,
built-in defaults are used. Env overrides: `PORT`, `REFRESH_SECONDS`,
`WARN_DAYS`, `CRITICAL_DAYS`, `ALERT_ENABLED`. Alert SMTP via `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `ALERT_FROM`, `ALERT_TO`.

A target:
```json
{
  "name": "SMSGateway (AWS)",
  "host": "ndbsms-uat.ndblk.int",
  "port": 443,
  "servername": "ndbsms-uat.ndblk.int",
  "health": { "type": "https", "port": 443, "path": "/SMSGateway/actuator/health" },
  "bundledCerts": ["/certs/dialog.lk.crt"]
}
```
`health.type` is `http` | `https` | `tcp` | `none`. No secrets belong in config.

## Build & deploy

```bash
docker build -t harbor.ndblk.int/ndb/sms-monitor:1.0.0 .
docker push harbor.ndblk.int/ndb/sms-monitor:1.0.0
# then: kubectl apply -f ../k8s/   (after replacing placeholders)
```

See `../docs/02-PRODUCTION-CHECKLIST.md` for what to replace before prod.
