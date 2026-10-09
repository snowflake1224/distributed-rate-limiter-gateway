# Example requests

Admin key (Compose default): `dev-admin-key-change-me`

Client keys are generated at seed time and written to `.local/seed-secrets.json`.

Nginx (`:8080`) does not expose `/admin/v1` or `/metrics`. Use an instance port (`:3000` or `:3002`) for those.

## Health and metrics

```bash
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
curl http://localhost:3000/metrics | head
```

## Admin API

```bash
curl -s http://localhost:3000/admin/v1/tenants \
  -H "X-Admin-Key: dev-admin-key-change-me"

curl -s http://localhost:3000/admin/v1/tenants \
  -H "X-Admin-Key: dev-admin-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"slug":"northstar","name":"Northstar"}'
```

Create an API key (plaintext is returned once):

```bash
TENANT_ID=...
curl -s http://localhost:3000/admin/v1/tenants/$TENANT_ID/api-keys \
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

Every response says which instance answered and which policy version decided it:

```
X-Gateway-Instance: gateway-2
X-RateLimit-Policy-Version: 1
RateLimit-Limit: 20
RateLimit-Remaining: 17
```

## Lab sandboxes

The same API the lab UI uses. Needs `jq`.

```bash
ORIGIN=http://localhost:8080

SBX=$(curl -s -X POST $ORIGIN/demo/v1/sandboxes -H 'content-type: application/json' -d '{
  "policy":   {"algorithm":"token_bucket","burstCapacity":5,"refillRatePerSec":0.5,"limitCount":10,"windowMs":10000,
               "dimensions":["tenant","api_key","route"],"customHeader":"x-user-id","failMode":"fail_closed"},
  "upstream": {"delayMs":0,"failRatePct":0,"failFirstN":0,"errorStatus":503,"timeoutMs":2000,
               "cbFailureThreshold":3,"cbRecoveryMs":5000,"cbHalfOpenMaxProbes":1}
}')
ID=$(echo "$SBX" | jq -r .sandbox.id)
KEY=$(echo "$SBX" | jq -r .apiKey)
TOKEN=$(echo "$SBX" | jq -r .token)

# 8 requests: 5 pass, then 429
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} remaining=%header{ratelimit-remaining} via=%header{x-gateway-instance}\n" \
    $ORIGIN/sbx/$ID/orders -H "x-api-key: $KEY"
done

# change the policy live (version bump, fresh bucket)
curl -s -X PATCH $ORIGIN/demo/v1/sandboxes/$ID -H "x-sandbox-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"policy":{"burstCapacity":20}}' | jq '.sandbox.policy.version, .handledBy'

# race 100 requests, 50 at a time, across both instances
curl -s -X POST $ORIGIN/demo/v1/sandboxes/$ID/runs -H "x-sandbox-token: $TOKEN" -H "x-sandbox-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d "{\"method\":\"GET\",\"path\":\"/sbx/$ID/orders\",\"count\":100,\"concurrency\":50,\"headers\":{}}" \
  | jq '[.rows[].outcome] | group_by(.) | map({(.[0]): length}) | add'

# break the upstream and watch both breakers
curl -s -X PATCH $ORIGIN/demo/v1/sandboxes/$ID -H "x-sandbox-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"upstream":{"failFirstN":6},"restartUpstreamCounter":true,"resetCircuit":true}' > /dev/null
sleep 6   # let both instances drop their cached upstream config
curl -s -X POST $ORIGIN/demo/v1/sandboxes/$ID/runs -H "x-sandbox-token: $TOKEN" -H "x-sandbox-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d "{\"method\":\"GET\",\"path\":\"/sbx/$ID/orders\",\"count\":10,\"concurrency\":1,\"headers\":{}}" \
  | jq -r '.rows | sort_by(.seq) | map("\(.instance):\(.outcome)") | join(" ")'
curl -s $ORIGIN/demo/v1/sandboxes/$ID -H "x-sandbox-token: $TOKEN" | jq '.instances[] | {instance, breaker: .breaker.state}'

curl -s -X DELETE $ORIGIN/demo/v1/sandboxes/$ID -H "x-sandbox-token: $TOKEN" -o /dev/null -w "%{http_code}\n"
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
