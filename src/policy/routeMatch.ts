import type { HttpMethod, Route } from "../types.js";

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((segment) => {
      if (segment === "*") {
        return ".*";
      }
      if (segment.startsWith(":")) {
        return "[^/]+";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${escaped}$`);
}

export function patternSpecificity(pattern: string): number {
  return pattern
    .split("/")
    .reduce((score, segment) => {
      if (segment === "*" || segment.startsWith(":")) {
        return score + 1;
      }
      return score + 10;
    }, 0);
}

export function methodMatches(routeMethod: HttpMethod, requestMethod: string): boolean {
  return routeMethod === "*" || routeMethod === requestMethod.toUpperCase();
}

export function matchRoute(routes: Route[], method: string, path: string): Route | null {
  const candidates = routes
    .filter((route) => methodMatches(route.method, method) && patternToRegex(route.pathPattern).test(path))
    .sort((a, b) => patternSpecificity(b.pathPattern) - patternSpecificity(a.pathPattern));
  return candidates[0] ?? null;
}

export function stripPathPrefix(path: string, prefix: string | null): string {
  if (!prefix) {
    return path;
  }
  if (path === prefix) {
    return "/";
  }
  if (path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}`)) {
    const next = path.slice(prefix.length);
    return next.startsWith("/") ? next : `/${next}`;
  }
  return path;
}
