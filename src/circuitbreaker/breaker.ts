import { circuitBreakerState, circuitBreakerTransitionsTotal } from "../metrics/registry.js";
import type { CircuitState } from "../types.js";

export interface BreakerOptions {
  name: string;
  failureThreshold: number;
  recoveryMs: number;
  halfOpenMaxProbes: number;
}

export class CircuitBreaker {
  state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbes = 0;
  private readonly options: BreakerOptions;

  constructor(options: BreakerOptions) {
    this.options = options;
    this.publishState();
  }

  canPass(): boolean {
    if (this.state === "closed") {
      return true;
    }
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.options.recoveryMs) {
        this.transition("half_open");
        this.halfOpenProbes = 0;
        return this.tryProbe();
      }
      return false;
    }
    return this.tryProbe();
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.transition("closed");
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open") {
      this.trip();
      return;
    }
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.trip();
    }
  }

  getState(): CircuitState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.options.recoveryMs) {
      this.transition("half_open");
      this.halfOpenProbes = 0;
    }
    return this.state;
  }

  private tryProbe(): boolean {
    if (this.halfOpenProbes >= this.options.halfOpenMaxProbes) {
      return false;
    }
    this.halfOpenProbes += 1;
    return true;
  }

  private trip(): void {
    this.openedAt = Date.now();
    this.transition("open");
  }

  private transition(next: CircuitState): void {
    if (this.state === next) {
      return;
    }
    circuitBreakerTransitionsTotal.inc({
      upstream: this.options.name,
      from: this.state,
      to: next
    });
    this.state = next;
    this.publishState();
  }

  private publishState(): void {
    const value = this.state === "closed" ? 0 : this.state === "half_open" ? 1 : 2;
    circuitBreakerState.set({ upstream: this.options.name }, value);
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(options: BreakerOptions): CircuitBreaker {
  const existing = breakers.get(options.name);
  if (existing) {
    return existing;
  }
  const created = new CircuitBreaker(options);
  breakers.set(options.name, created);
  return created;
}

export function resetBreakers(): void {
  breakers.clear();
}

export function listBreakerStates(): Array<{ name: string; state: CircuitState }> {
  return [...breakers.entries()].map(([name, breaker]) => ({
    name,
    state: breaker.getState()
  }));
}
