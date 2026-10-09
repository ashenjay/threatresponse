# SMSGateway (edge) and checking the JKS in the UI

The two services are monitored **separately** because their concerns differ:

| | SMSGateway | NDBSMSRouter |
|---|---|---|
| Role | **Edge** (public TLS front door + outbound client to Dialog) | **Internal** service |
| Platform | AWS (ECS / App Runner) | On-prem TKG (Tanzu) |
| Main cert concern | **JKS truststore** — does it still trust Dialog | Service up/health |
| Monitored by | `MONITOR_PROFILE=gateway` (`config.gateway.json`) | `MONITOR_PROFILE=router` (`config.router.json`) |

Run one monitor instance per environment (set `MONITOR_PROFILE`), or one
instance watching both (`MONITOR_PROFILE=all`, the default).

## What the gateway card shows

1. **Served TLS cert** — the cert the gateway presents to clients (the
   `*.ndblk.int` wildcard). Tells you the front door is valid.
2. **Upstream: Dialog** — the monitor probes Dialog's own endpoint and reads
   the cert Dialog serves (the `dialog.lk` leaf, expiring 2026-12-14). This is
   the cert the gateway **must trust**.
3. **JKS Truststore** — a table of every alias in the mounted truststore with
   its CN and days-to-expiry. This is how you confirm a JKS update worked.

The three together answer: *is the edge healthy, is the thing it must trust
still valid, and does my truststore actually contain a valid copy of it.*

## How the JKS update is checked in the UI

The monitor reads the JKS file **mounted into it read-only** (no password
needed to list trusted certs). So the loop is:

1. Mount the truststore into the monitor (K8s Secret or the same EFS file the
   gateway uses) and set `"truststore": "/certs/dialog-truststore.jks"` in
   `config.gateway.json`.
2. The gateway card shows the current `dialog-lk` entry at **N days**.
3. You rotate the cert (see `03-RUNBOOK-cert-rotation.md`): replace the mounted
   JKS file, restart the gateway task/pod — **no image rebuild**.
4. Point the monitor at the **same new file** (if it mounts the gateway's EFS
   file, it's automatic; if it has its own copy, update that Secret too).
5. Click **Refresh now** (or wait for auto-refresh). The `dialog-lk` row shows
   the new expiry and the truststore pill goes green. That is your proof.

> The monitor and the gateway should read the **same** truststore source so
> the UI reflects what the gateway actually loaded. Easiest: mount the gateway
> EFS file into the monitor pod read-only, or sync the same K8s Secret.

## Mounting the JKS into the monitor

### K8s (if the monitor runs on-prem next to the router, or anywhere on TKG)
```bash
kubectl create secret generic sms-gateway-certs \
  --from-file=dialog-truststore.jks=./dialog-truststore.jks -n sms-monitor
```
Then in `k8s/03-deployment.yaml` uncomment the `certs` volume + mount (it maps
to `/certs`) and set `"truststore": "/certs/dialog-truststore.jks"` in the
ConfigMap.

### Reaching the AWS gateway from the monitor
The monitor only needs to open TCP 443 to the gateway endpoint to read the
**served** cert; for the **truststore** table it just needs the JKS file
mounted. So even if the monitor runs on-prem, the truststore table works
offline from the mounted file, and the served/upstream probes work as long as
the gateway/Dialog endpoints are reachable (over your VPN/Direct Connect or
public egress).
