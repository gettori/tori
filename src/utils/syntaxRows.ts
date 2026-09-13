// The eager face of diff-row highlighting: a synchronous, reactive lookup that
// answers null until the lazily imported Lezer engine and the path's language
// have both arrived, then answers spans per row. Same shape as the chat's
// `highlight.ts`, and the same cap, so a block too big to colour there is too
// big here.
import { createSignal } from "solid-js";
import { HIGHLIGHT_MAX } from "../panels/Chat/highlight";
import type { DiffRow } from "./diffView";

type Engine = typeof import("../panels/Editor/syntaxLines");
type Language = NonNullable<Awaited<ReturnType<Engine["languageForPath"]>>>;
export type Span = ReturnType<Engine["tokenLines"]>[number][number];

const [version, setVersion] = createSignal(0);
let engine: Engine | null = null;
let engineRequested = false;
const languages = new Map<string, Language | null>();
const requested = new Set<string>();

const bump = () => setVersion((v) => v + 1);

// Keyed by suffix, which is all `languageForPath` reads, so one import serves
// every file of a kind rather than one per path.
function suffixOf(path: string): string {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  return file.split(".").pop() ?? "";
}

function ready(path: string): Language | null {
  if (!engine) {
    if (!engineRequested) {
      engineRequested = true;
      import("../panels/Editor/syntaxLines").then(
        (m) => {
          engine = m;
          bump();
        },
        // A failed chunk load leaves every row plain, which is the fallback
        // rendering anyway; nothing retries because nothing would change.
        () => {},
      );
    }
    return null;
  }
  const key = suffixOf(path);
  if (languages.has(key)) return languages.get(key)!;
  if (!requested.has(key)) {
    requested.add(key);
    engine.languageForPath(path).then(
      (lang) => {
        languages.set(key, lang);
        bump();
      },
      () => languages.set(key, null),
    );
  }
  return null;
}

function body(row: DiffRow): string {
  if (row.kind === "context") return row.text.startsWith(" ") ? row.text.slice(1) : row.text;
  return row.text.slice(1);
}

/**
 * Spans for each row, or null while nothing can be painted (no engine yet, no
 * language for this path, or a hunk past the cap). A `meta` row is null on its
 * own: it is git talking, not code.
 *
 * Each side is highlighted as its own text rather than the two interleaved: the
 * removed lines and the added lines are each a coherent fragment, and the
 * mixture of them is neither and tokenizes as neither.
 */
export function paintRows(rows: DiffRow[], path: string): (Span[] | null)[] | null {
  version();
  const lang = path ? ready(path) : null;
  if (!lang) return null;
  const side = (drop: DiffRow["kind"]) =>
    rows
      .filter((r) => r.kind !== drop && r.kind !== "meta")
      .map(body)
      .join("\n");
  const oldText = side("add");
  const newText = side("del");
  if (oldText.length > HIGHLIGHT_MAX || newText.length > HIGHLIGHT_MAX) return null;
  const before = engine!.tokenLines(oldText, lang);
  const after = engine!.tokenLines(newText, lang);
  // Walked rather than indexed: a row's place in its own side is not its place
  // in the hunk, and a changed row exists on only one of the two.
  let oldAt = 0;
  let newAt = 0;
  return rows.map((row) => {
    if (row.kind === "meta") return null;
    if (row.kind === "add") return after[newAt++] ?? null;
    if (row.kind === "del") return before[oldAt++] ?? null;
    oldAt++;
    return after[newAt++] ?? null;
  });
}

export type Piece = { text: string; cls: string | null; changed: boolean };

/** The spans cut at `[from, to)` so the changed run can carry its own mark on
 *  top of the token colours, without either side losing the other. */
export function overlay(spans: Span[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const span of spans) {
    let text = span.text;
    let pos = at;
    for (const cut of [from, to]) {
      const n = cut - pos;
      if (n > 0 && n < text.length) {
        out.push({ text: text.slice(0, n), cls: span.cls, changed: pos >= from && pos < to });
        text = text.slice(n);
        pos = cut;
      }
    }
    if (text) out.push({ text, cls: span.cls, changed: pos >= from && pos < to });
    at += span.text.length;
  }
  return out;
}
