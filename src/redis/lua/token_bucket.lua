-- Atomic token-bucket decision.
-- KEYS[1] = bucket key
-- ARGV[1] = capacity
-- ARGV[2] = refill_rate_per_sec
-- ARGV[3] = cost
-- ARGV[4] = idle_ttl_ms
--
-- Uses Redis TIME so every gateway instance shares one clock.
-- Returns: { allowed, remaining, retry_after_ms, now_ms, reset_ms, limit }

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

local time = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
else
  local elapsed_ms = now_ms - ts
  if elapsed_ms > 0 then
    tokens = math.min(capacity, tokens + (elapsed_ms * refill_rate / 1000.0))
    ts = now_ms
  end
end

local allowed = 0
local retry_after_ms = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local missing = cost - tokens
  if refill_rate > 0 then
    retry_after_ms = math.ceil((missing / refill_rate) * 1000.0)
  else
    retry_after_ms = ttl_ms
  end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', ts)
redis.call('PEXPIRE', key, ttl_ms)

local remaining = math.floor(tokens)
local reset_ms
if tokens >= capacity then
  reset_ms = now_ms
else
  local need = capacity - tokens
  reset_ms = now_ms + math.ceil((need / refill_rate) * 1000.0)
end

return { allowed, remaining, retry_after_ms, now_ms, reset_ms, capacity }
