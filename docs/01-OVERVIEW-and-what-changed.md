# NDB SMS Services — Monitor & Cert Externalization

This repo adds a **monitoring dashboard** for the two SMS services and a
**safer way to handle TLS certificates** so you can rotate them without
rebuilding images. Nothing here touches the running services' logic — the
monitor only *observes*, and the externalized Dockerfile only changes *how*
the gateway loads its truststore.

## The two services (unchanged)

| Service | Platform | Port | TLS cert concern |
|---|---|---|---|
| **SMSGateway** | AWS (App Runner / ECS) | 8086 | Trusts Dialog chain via a custom JKS |
| **NDBSMSRouter** | On-prem TKG (Kubernetes) | 8085 | Talks to SMSGateway + Oracle |

## What this repo contains

```
cert-monitor/        Node.js monitor: live TLS expiry + service health + web UI
  src/               server, cert probe, health probe, optional email alerts
  public/index.html  dashboard (auto-refresh, red/amber/green per cert)
  Dockerfile         tiny, non-root, zero required deps
  config.example.json
k8s/                 manifests to run the monitor on TKG (contour ingress)
smsgateway/
  Dockerfile.externalized   gateway build that MOUNTS the truststore
docs/                this overview + production checklist + rotation runbook
```

## Key finding — why cert externalization matters now

Live expiry dates read from the cert files you sent:

| Cert | Expires | Days (as of 2026-10-09) |
|---|---|---|
| **Dialog leaf (`dialog.lk`)** | **2026-12-14** | ~66 — rotate before December |
| NDB wildcard `*.ndblk.int` | 2027-08-04 | ~300 |
| DigiCert G2 intermediate | 2031-03-29 | fine |

## What changed vs. the original setup

**Original SMSGateway Dockerfile** imported certs into the JVM `cacerts` at
build time with `keytool`. That means **every cert rotation = rebuild +
redeploy the image**.

**`smsgateway/Dockerfile.externalized`** imports nothing. The truststore is a
**mounted file** (`/app/config/dialog-truststore.jks`) and the JVM is pointed
at it with `-Djavax.net.ssl.trustStore`. Rotating a cert is now: replace the
mounted file, restart the task/pod. **No rebuild.**

> This is backwards-compatible: the app still uses the same JKS, same alias
> layout, same password. We only moved the file from an image layer to a
> mount. If you prefer, you can keep running the original image and adopt this
> only at the next rotation.

## "Can we build outside / update the cert anytime?" — yes

- **Build the image once**, with no certs in it.
- Supply the truststore from **outside** the image at run time:
  - **K8s (router / monitor cluster):** a `Secret` mounted as a file.
  - **ECS (gateway):** an **EFS** volume holding the JKS (recommended), or an
    entrypoint that pulls it from S3 / Secrets Manager at start.
- To update a cert any time: update the mounted file → restart. See
  `docs/03-RUNBOOK-cert-rotation.md`.

## How to not break anything

- The monitor is **read-only**: it opens TLS connections and HTTP health
  probes. It cannot change the services.
- The externalized Dockerfile is **opt-in** and side-by-side (it does not
  replace your current one). Test it in UAT first (checklist in
  `docs/02-PRODUCTION-CHECKLIST.md`).
- No secrets are committed: jars, `.jks`, `.crt`, `.p12`, keys and
  `application.yaml` are git-ignored.
