export interface LabSpec {
  sandboxId: string;
  revision: number;
  delayMs: number;
  failRatePct: number;
  failFirstN: number;
  errorStatus: number;
}

const SEGMENT = /^\/lab\/([a-z0-9]{1,32})\/r(\d{1,9})\/d(\d{1,5})\/f(\d{1,3})\/n(\d{1,3})\/s(\d{3})(\/.*)?$/;

export function labBasePath(spec: LabSpec): string {
  return `/lab/${spec.sandboxId}/r${spec.revision}/d${spec.delayMs}/f${spec.failRatePct}/n${spec.failFirstN}/s${spec.errorStatus}`;
}

export function parseLabPath(path: string): { spec: LabSpec; rest: string } | null {
  const match = SEGMENT.exec(path);
  if (!match) {
    return null;
  }
  const [, sandboxId, revision, delay, failRate, failFirst, status, rest] = match;
  const spec: LabSpec = {
    sandboxId: sandboxId!,
    revision: Number(revision),
    delayMs: Math.min(Number(delay), 3_000),
    failRatePct: Math.min(Number(failRate), 100),
    failFirstN: Math.min(Number(failFirst), 50),
    errorStatus: Number(status)
  };
  if (![500, 502, 503].includes(spec.errorStatus)) {
    return null;
  }
  return { spec, rest: rest || "/" };
}
