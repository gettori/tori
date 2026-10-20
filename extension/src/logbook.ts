import type { LogEntry, LogKind, Tally } from "./pick";

const TEXT_CAP = 500;
const STACK_LINES = 4;
const KEEP = 50;

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

// Next logs the build failure to the console as well; the overlay already says it.
export function restates(overlay: string | null, text: string): boolean {
  const head = flat(text).slice(0, 80);
  return !!overlay && head.length >= 20 && flat(overlay).includes(head);
}

function stackOf(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  return [head, ...frames.slice(0, STACK_LINES)].join("\n");
}

export function show(value: unknown): string {
  if (value instanceof Error) return stackOf(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// The way the console reads its arguments, so React's "%s" warnings read whole.
export function fillDirectives(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== "string" || !first.includes("%")) return args.map(show).join(" ");
  const text = first.replace(/%[sdifoOc%]/g, (directive) => {
    if (directive === "%%") return "%";
    if (!rest.length) return directive;
    const value = rest.shift();
    return directive === "%c" ? "" : show(value);
  });
  return [text, ...rest.map(show)].join(" ");
}

export class Logbook {
  private seq = 0;
  private readonly sent = new Set<number>();
  private overflow = 0;
  private last: LogEntry | null = null;
  private shown: string | null = null;
  // Errors keep the first ones, since the first is usually the cause; the rest roll.
  private readonly errors: LogEntry[] = [];
  private readonly rolling: Record<"warn" | "request" | "overlay", LogEntry[]> = {
    warn: [],
    request: [],
    overlay: [],
  };

  add(kind: LogKind, text: string, now = Date.now(), reportable = false): boolean {
    if (kind === "error" && restates(this.shown, text)) return false;
    const capped = text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}...` : text;
    const last = this.last;
    if (last && last.kind === kind && last.text === capped && !this.sent.has(last.seq)) {
      last.count++;
      return true;
    }
    const rolls = kind === "warn" || kind === "request" || kind === "overlay";
    const list = rolls ? this.rolling[kind] : this.errors;
    if (!rolls && list.length >= KEEP) {
      if (reportable) this.overflow++;
      return reportable;
    }
    this.last = { seq: ++this.seq, at: now, kind, text: capped, count: 1, reportable };
    list.push(this.last);
    if (list.length > KEEP) this.forget(list.shift()!);
    return true;
  }

  // An overlay is the build failing, so it stays one entry until it goes away.
  overlay(text: string | null, now = Date.now()): boolean {
    const changed = !!text && text !== this.shown;
    if (text && changed) {
      this.dropRestated(text);
      this.add("overlay", text, now, true);
    }
    this.shown = text;
    return changed;
  }

  mark(seqs: number[]) {
    for (const seq of seqs) if (seq <= this.seq) this.sent.add(seq);
  }

  unsent(): LogEntry[] {
    const all = [...this.errors, ...this.rolling.warn, ...this.rolling.request, ...this.rolling.overlay];
    return all.filter((e) => !this.sent.has(e.seq)).sort((a, b) => a.seq - b.seq);
  }

  tally(): Tally {
    const count = this.unsent().reduce((sum, e) => sum + (e.reportable ? e.count : 0), 0);
    return { count, overflow: this.overflow };
  }

  private forget(entry: LogEntry) {
    if (this.sent.delete(entry.seq)) return;
    if (entry.reportable) this.overflow += entry.count;
  }

  private dropRestated(overlay: string) {
    for (let i = this.errors.length - 1; i >= 0; i--) {
      const entry = this.errors[i];
      if (entry.kind !== "error" || this.sent.has(entry.seq) || !restates(overlay, entry.text)) continue;
      this.errors.splice(i, 1);
      if (this.last === entry) this.last = null;
    }
  }
}
