# NDB SMS Services — monitoring & cert externalization

Tooling around the two NDB SMS services (**SMSGateway** on AWS, port 8086;
**NDBSMSRouter** on TKG Kubernetes, port 8085). It adds a monitoring dashboard
and a cert-handling approach that lets you rotate TLS certificates **without
rebuilding images**. It does not change the services' own logic.

## Contents

| Path | What |
|---|---|
| `cert-monitor/` | Node.js monitor: live TLS expiry + service health + web UI |
| `k8s/` | Manifests to run the monitor on TKG (contour ingress) |
| `smsgateway/Dockerfile.externalized` | Gateway build that **mounts** the truststore instead of baking it |
| `docs/` | Overview + production checklist + cert-rotation runbook |

## Start here

1. `docs/01-OVERVIEW-and-what-changed.md` — what this is and what changed.
2. `docs/02-PRODUCTION-CHECKLIST.md` — everything to replace before prod.
3. `docs/03-RUNBOOK-cert-rotation.md` — how to rotate a cert with no rebuild.

## Heads-up

The **Dialog leaf cert expires 2026-12-14** (~66 days as of 2026-10-09). The
monitor will flag it amber at 30 days and red at 7. Plan the rotation using the
runbook.

## Security

No secrets live in this repo. Jars, `.jks`/`.crt`/`.pem`/`.p12`/keys,
`application.yaml`, and the real `k8s/02-secret.yaml` are git-ignored. The
monitor needs only hostnames, ports and (optionally) a public cert file.
