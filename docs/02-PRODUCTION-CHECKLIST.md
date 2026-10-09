# Production promotion checklist

Everything you must **replace** before this runs in production. Work top to
bottom; nothing here changes service logic.

## A. Monitor — values to replace

| Where | Field | UAT / placeholder | Replace with |
|---|---|---|---|
| `k8s/01-configmap.yaml` | SMSGateway `host`/`servername` | `ndbsms-uat.ndblk.int` | **prod gateway host** |
| `k8s/01-configmap.yaml` | Router `host`/`servername` | `ndbsmsrouter.ndblk.int` | **prod router host** |
| `k8s/01-configmap.yaml` | health `path` | `/actuator/health` | real health paths (see §D) |
| `k8s/03-deployment.yaml` | `image` | `harbor.ndblk.int/ndb/sms-monitor:latest` | your Harbor repo + a **pinned tag** (not `latest`) |
| `k8s/05-ingress.yaml` | `host` (rule + tls) | `sms-monitor.ndblk.int` | prod DNS name |
| `k8s/05-ingress.yaml` | `secretName` | `ndblk-int-tls` | your real TLS secret (`kubectl get secrets -A \| grep tls`) |
| `k8s/05-ingress.yaml` | `ingressClassName` | `contour` | `contour` on TKG, else `nginx` |

> Prefer a pinned image tag (e.g. `:1.0.0` or a git SHA) over `:latest` so
> rollbacks are deterministic.

## B. Email alerts (optional)

Only if you want email on cert-critical / service-down:

1. `k8s/01-configmap.yaml` → set `"alert": { "enabled": true }`.
2. `k8s/03-deployment.yaml` → set `ALERT_ENABLED` to `"true"`.
3. Copy `k8s/02-secret.example.yaml` → `02-secret.yaml`, fill in real SMTP
   host/user/**password** and `ALERT_TO`. Apply it separately.
   `02-secret.yaml` is git-ignored — never commit the real password.

## C. SMSGateway cert externalization (when you adopt it)

Replacing the baked-cert image with `smsgateway/Dockerfile.externalized`:

1. Build: `docker build -f smsgateway/Dockerfile.externalized -t <registry>/sms-gateway:<tag> smsgateway/`
   (ensure `target6/SMSGateway.jar` is present in the build context).
2. Make the truststore available at `/app/config/dialog-truststore.jks`:
   - **ECS:** create an **EFS** access point, put the JKS on it, add it as a
     volume, mount at `/app/config`. Updating the cert = replace the file on
     EFS + restart the task.
   - **K8s:** `kubectl create secret generic sms-gateway-certs
     --from-file=dialog-truststore.jks=./dialog-truststore.jks` and mount it
     at `/app/config`.
3. Set `TRUSTSTORE_PASS` if your JKS password is not `changeit`.
4. Confirm the app's `application.yaml` truststore path (if it sets one)
   points at `/app/config/dialog-truststore.jks`.
5. Verify in UAT (see §E) **before** prod.

## D. Health endpoints — confirm the real paths

The config assumes Spring Boot Actuator at `/actuator/health`. Confirm it is
exposed on each service:

- If actuator is enabled: ensure `management.endpoints.web.exposure.include`
  contains `health`, and note the port (same app port unless a separate
  management port is set).
- If actuator is **not** exposed, change the target's `health` to a path that
  returns 2xx, or switch `"type"` to `"tcp"` to just check the port is open.

## E. Pre-prod verification

- [ ] `GET /healthz` on the monitor returns `{"status":"ok"}`.
- [ ] `GET /api/status?fresh=1` shows both services with a **cert expiry date
      and day count**, and `chain trusted` = yes for each.
- [ ] Dashboard loads over the ingress host and auto-refreshes.
- [ ] (If externalized gateway) UAT gateway starts, `sendSms` still works with
      the mounted truststore, TLS to Dialog succeeds.
- [ ] (If alerts) force a critical (temporarily set `criticalDays` very high)
      and confirm one email arrives, throttled.

## F. Secrets that must NEVER enter git

Already covered by `.gitignore`, listed so reviewers know: the `.jar` files,
any `.jks` / `.crt` / `.pem` / `.p12`, the Oracle DB password, the AES keys,
the API keys, and the real `k8s/02-secret.yaml`. The monitor needs none of
these except, optionally, a public cert file to read.
