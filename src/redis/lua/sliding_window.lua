-- Precise sliding-window decision using a sorted set of request timestamps.
-- KEYS[1] = window key
-- ARGV[1] = window_ms
-- ARGV[2] = limit
-- ARGV[3] = unique member
-- ARGV[4] = ttl_ms
--
-- ZREMRANGEBYSCORE drops events older than now-window, then ZCARD counts
-- events still inside the window. ZADD records this request only if allowed.
-- Returns: { allowed, remaining, retry_after_ms, now_ms, reset_ms, limit }

local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
local ttl_ms = tonumber(ARGV[4])

local time = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window_start = now_ms - window_ms

redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
local count = redis.call('ZCARD', key)

local allowed = 0
local remaining = 0
local retry_after_ms = 0
local reset_ms = now_ms + window_ms

if count < limit then
  redis.call('ZADD', key, now_ms, member)
  allowed = 1
  remaining = limit - count - 1
else
  remaining = 0
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] ~= nil then
    local oldest_ms = tonumber(oldest[2])
    retry_after_ms = oldest_ms + window_ms - now_ms
    reset_ms = oldest_ms + window_ms
    if retry_after_ms < 0 then
      retry_after_ms = 0
    end
  else
    retry_after_ms = window_ms
  end
end

redis.call('PEXPIRE', key, ttl_ms)
return { allowed, remaining, retry_after_ms, now_ms, reset_ms, limit }
