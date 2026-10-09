# Runbook — rotating the Dialog (or wildcard) certificate

**Use this when the monitor shows a cert going amber/red, or ahead of the
Dialog leaf expiry on 2026-12-14.** With the externalized truststore you do
**not** rebuild any image.

## 0. Before you touch anything

- Note which cert is expiring (monitor card → "Subject (CN)" + "Expires").
- Get the replacement cert from the issuer:
  - **Dialog leaf** → from Dialog Axiata (the `dialog.lk` cert + its chain).
  - **NDB wildcard `*.ndblk.int`** → from NDB internal CA.
- Keep the **old truststore** as a backup so you can roll back instantly.

## 1. Build the new truststore (off the servers, any workstation)

The truststore needs 4 entries (matching what the gateway expects):

| Alias | What | Type |
|---|---|---|
| `dialog-lk` | Dialog leaf cert | trustedCert |
| `digicert-intermediate` | DigiCert Global G2 TLS RSA SHA256 2020 CA1 | trustedCert |
| `digicert-root-g2` | DigiCert Global Root G2 | trustedCert |
| `wildcard` | NDB `*.ndblk.int` (with its private key) | PrivateKeyEntry |

```bash
# Start from the current truststore (keeps the wildcard PrivateKeyEntry intact)
cp dialog-truststore.jks dialog-truststore-new.jks

# Replace the Dialog leaf: delete old alias, import the new leaf
keytool -delete -alias dialog-lk -keystore dialog-truststore-new.jks -storepass changeit
keytool -importcert -trustcacerts -alias dialog-lk \
  -file dialog-new-leaf.pem -keystore dialog-truststore-new.jks \
  -storepass changeit -noprompt

# (Only if the intermediate/root also changed, repeat -delete/-importcert
#  for digicert-intermediate / digicert-root-g2.)

# Verify the new leaf's expiry is in the future:
keytool -list -v -keystore dialog-truststore-new.jks -storepass changeit \
  | grep -A2 "Alias name: dialog-lk"
```

> If the password is not `changeit`, use the real one and set `TRUSTSTORE_PASS`
> on the container to match.

## 2. Swap the file (NO rebuild)

### SMSGateway on ECS (EFS-mounted truststore)
1. Copy `dialog-truststore-new.jks` onto the EFS path, replacing the old file
   (keep a `.bak`).
2. Force a new deployment so the task restarts and re-reads it:
   `aws ecs update-service --cluster <c> --service <svc> --force-new-deployment`
3. Watch the task come healthy.

### SMSGateway / router on K8s (Secret-mounted truststore)
```bash
# Replace the secret in place
kubectl create secret generic sms-gateway-certs \
  --from-file=dialog-truststore.jks=./dialog-truststore-new.jks \
  --dry-run=client -o yaml | kubectl apply -n <ns> -f -

# Restart to pick it up
kubectl rollout restart deploy/<gateway-deploy> -n <ns>
kubectl rollout status  deploy/<gateway-deploy> -n <ns>
```

## 3. Verify

- Monitor dashboard → the cert card flips back to **green**, new expiry date.
- `GET /api/status?fresh=1` → `cert.daysRemaining` is large, `authorized: true`.
- Send one test `sendSms` through the gateway and confirm success.

## 4. Roll back (if TLS breaks)

- **ECS:** restore the `.bak` JKS on EFS, `--force-new-deployment`.
- **K8s:** re-apply the secret from the old JKS, `kubectl rollout undo`.

## Why this is safe

The image never changes during a rotation, so the only variable is the
truststore file. If the new file is wrong, the old one is one command away.
Nothing about the service code, keys or endpoints is touched.
