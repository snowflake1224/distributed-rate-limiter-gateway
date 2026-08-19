export interface TokenBucketState {
  tokens: number;
  ts: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetMs: number;
  state: TokenBucketState;
}

export function applyTokenBucket(
  state: TokenBucketState | null,
  nowMs: number,
  capacity: number,
  refillRatePerSec: number,
  cost = 1
): TokenBucketResult {
  let tokens = state?.tokens ?? capacity;
  let ts = state?.ts ?? nowMs;
  if (nowMs > ts) {
    tokens = Math.min(capacity, tokens + ((nowMs - ts) * refillRatePerSec) / 1000);
    ts = nowMs;
  }

  let allowed = false;
  let retryAfterMs = 0;
  if (tokens >= cost) {
    tokens -= cost;
    allowed = true;
  } else {
    const missing = cost - tokens;
    retryAfterMs = Math.ceil((missing / refillRatePerSec) * 1000);
  }

  const remaining = Math.floor(tokens);
  const resetMs =
    tokens >= capacity ? nowMs : nowMs + Math.ceil(((capacity - tokens) / refillRatePerSec) * 1000);
  return { allowed, remaining, retryAfterMs, resetMs, state: { tokens, ts } };
}

export interface SlidingWindowResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetMs: number;
  timestamps: number[];
}

export function applySlidingWindow(
  timestamps: number[],
  nowMs: number,
  windowMs: number,
  limit: number
): SlidingWindowResult {
  const windowStart = nowMs - windowMs;
  const live = timestamps.filter((ts) => ts > windowStart);
  if (live.length < limit) {
    return {
      allowed: true,
      remaining: limit - live.length - 1,
      retryAfterMs: 0,
      resetMs: nowMs + windowMs,
      timestamps: [...live, nowMs]
    };
  }
  const oldest = live[0] ?? nowMs;
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: Math.max(0, oldest + windowMs - nowMs),
    resetMs: oldest + windowMs,
    timestamps: live
  };
}
