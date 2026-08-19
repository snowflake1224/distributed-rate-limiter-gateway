# PromQL cheat sheet

These queries match metrics exposed on `/metrics`.

```promql
sum(rate(gateway_http_requests_total[1m]))
sum(rate(gateway_ratelimit_allowed_total[1m]))
sum(rate(gateway_ratelimit_rejected_total[1m]))

histogram_quantile(0.50, sum(rate(gateway_request_duration_seconds_bucket[1m])) by (le))
histogram_quantile(0.95, sum(rate(gateway_request_duration_seconds_bucket[1m])) by (le))
histogram_quantile(0.99, sum(rate(gateway_request_duration_seconds_bucket[1m])) by (le))

histogram_quantile(0.95, sum(rate(gateway_redis_latency_seconds_bucket[1m])) by (le, command))
histogram_quantile(0.95, sum(rate(gateway_postgres_latency_seconds_bucket[1m])) by (le, operation))
histogram_quantile(0.95, sum(rate(gateway_ratelimit_decision_duration_seconds_bucket[1m])) by (le, algorithm))

sum(rate(gateway_policy_cache_hits_total[1m]))
  /
(sum(rate(gateway_policy_cache_hits_total[1m])) + sum(rate(gateway_policy_cache_misses_total[1m])))

gateway_circuit_breaker_state
sum(rate(gateway_upstream_failures_total[1m])) by (reason)
gateway_eventloop_lag_seconds
gateway_nodejs_eventloop_lag_seconds
gateway_active_tenants
gateway_active_policies
process_resident_memory_bytes
rate(process_cpu_seconds_total[1m])
```
