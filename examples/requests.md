# Example requests

Admin key (Compose default): `dev-admin-key-change-me`

Client keys are generated at seed time and written to `.local/seed-secrets.json`.

## Health and metrics

```bash
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
curl http://localhost:3000/metrics | head
```

## Admin API

```bash
curl -s http://localhost:8080/admin/v1/tenants \
  -H "X-Admin-Key: dev-admin-key-change-me"

curl -s http://localhost:8080/admin/v1/tenants \
  -H "X-Admin-Key: dev-admin-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"slug":"northstar","name":"Northstar"}'
```

Create an API key (plaintext is returned once):

```bash
TENANT_ID=...
curl -s http://localhost:8080/admin/v1/tenants/$TENANT_ID/api-keys \
  -H "X-Admin-Key: dev-admin-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"rotation-candidate"}'
```

## Gateway traffic

```bash
ACME=$(node -e "console.log(require('./.local/seed-secrets.json').acmeKey)")

curl -i http://localhost:8080/api/orders \
  -H "X-API-Key: $ACME"

curl -i http://localhost:8080/api/search \
  -H "X-API-Key: $ACME" \
  -H "X-User-Id: user-42"

curl -i http://localhost:8080/api/flaky \
  -H "X-API-Key: $ACME"
```

Burst the token-bucket route:

```bash
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    http://localhost:8080/api/orders -H "X-API-Key: $ACME"
done
```

Prove both instances share Redis state by pinning each instance:

```bash
curl -i http://localhost:3000/api/orders -H "X-API-Key: $ACME"
curl -i http://localhost:3002/api/orders -H "X-API-Key: $ACME"
```

## Failure drills

```bash
docker compose stop redis
curl -i http://localhost:8080/api/orders -H "X-API-Key: $ACME"
# expect 503, fail-closed

docker compose start redis
docker compose stop postgres
curl -i http://localhost:8080/api/orders -H "X-API-Key: $ACME"
# cache hit may still work until TTL; cache miss returns 503
```
