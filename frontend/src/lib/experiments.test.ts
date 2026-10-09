import { describe, expect, it } from "vitest";
import { EXPERIMENTS, defaultParams, simulateBreakers, validateParams } from "./experiments";

describe("simulateBreakers", () => {
  it("opens each instance's breaker independently after the threshold", () => {
    const order = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? "gateway-1" : "gateway-2"));
    expect(simulateBreakers(order, 6, 3)).toEqual([
      "upstream_error",
      "upstream_error",
      "upstream_error",
      "upstream_error",
      "upstream_error",
      "upstream_error",
      "circuit_open",
      "circuit_open",
      "circuit_open",
      "circuit_open"
    ]);
  });

  it("resets the failure count after a success", () => {
    expect(simulateBreakers(["a", "a", "a", "a"], 2, 3)).toEqual(["upstream_error", "upstream_error", "allowed", "allowed"]);
  });
});

describe("experiment definitions", () => {
  it("have valid defaults and one step label per planned step", () => {
    for (const experiment of EXPERIMENTS) {
      const params = defaultParams(experiment);
      expect(validateParams(experiment, params)).toEqual([]);
      const steps = experiment.steps(params);
      expect(steps.length).toBeGreaterThan(0);
      expect(new Set(steps).size).toBe(steps.length);
    }
  });

  it("rejects out-of-range parameters", () => {
    const burst = EXPERIMENTS.find((e) => e.id === "burst")!;
    expect(validateParams(burst, { ...defaultParams(burst), capacity: 0 })).toHaveLength(1);
  });
});
