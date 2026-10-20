import type { LogKind } from "./pick";

export type Source = { file?: string; stack?: string; status?: number | "failed" };

// A bundler's own scheme (webpack-internal:, a bare path) has a null origin and is the page's code;
// only an address with a real origin can be someone else's.
function foreign(url: string, origin: string): boolean {
  try {
    const at = new URL(url, origin).origin;
    return at !== "null" && at !== origin;
  } catch {
    return false;
  }
}

function topFrame(stack: string): string | null {
  for (const line of stack.split("\n")) {
    if (!/^\s+at /.test(line)) continue;
    const found = /\(?([a-z][\w+.-]*:[^\s()]+?):\d+:\d+\)?\s*$/i.exec(line);
    if (found) return found[1];
  }
  return null;
}

export function reportable(kind: LogKind, source: Source, origin: string): boolean {
  switch (kind) {
    case "overlay":
      return true;
    case "uncaught":
    case "rejection": {
      const from = source.file || (source.stack ? topFrame(source.stack) : null);
      // A cross-origin script's error reaches the page as "Script error." with nothing to go on.
      if (!from) return kind === "rejection";
      return !foreign(from, origin);
    }
    case "request": {
      const failed = source.status === "failed" || (typeof source.status === "number" && source.status >= 500);
      return failed && !!source.file && !foreign(source.file, origin);
    }
    default:
      return false;
  }
}

export function throttle(ms: number, post: () => void) {
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let again = false;
  const fire = () => {
    post();
    waiting = setTimeout(() => {
      waiting = null;
      if (again) {
        again = false;
        fire();
      }
    }, ms);
  };
  return () => {
    if (waiting === null) fire();
    else again = true;
  };
}
