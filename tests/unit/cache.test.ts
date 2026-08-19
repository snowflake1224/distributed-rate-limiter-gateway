import { describe, expect, it } from "vitest";
import { TtlLruCache } from "../../src/cache/ttlLru.js";

describe("TTL LRU cache", () => {
  it("evicts the least recently used entry when over capacity", () => {
    const cache = new TtlLruCache<string>({ max: 2, ttlMs: 10_000 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
  });

  it("expires entries after ttl", async () => {
    const cache = new TtlLruCache<string>({ max: 10, ttlMs: 15 });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cache.get("k")).toBeUndefined();
  });

  it("invalidates by prefix", () => {
    const cache = new TtlLruCache<string>({ max: 10, ttlMs: 10_000 });
    cache.set("route:t1:GET:/a", "one");
    cache.set("route:t2:GET:/a", "two");
    cache.deleteByPrefix("route:t1:");
    expect(cache.get("route:t1:GET:/a")).toBeUndefined();
    expect(cache.get("route:t2:GET:/a")).toBe("two");
  });
});
