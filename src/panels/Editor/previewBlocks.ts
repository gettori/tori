// A markdown document as the preview draws it: runs of prose tokens and fences
// as their own blocks, lexed in steps the caller can spread over frames.
//
// It is marked's own `lex()`, taken apart at its seams: the block pass runs a
// chunk at a time and collects every link definition, then the inline queue
// runs in batches, so a reference resolves exactly as in one pass.
import { marked, type Token } from "marked";

export type PreviewBlock =
  | { kind: "prose"; tokens: Token[]; key: string }
  | { kind: "code"; lang: string; code: string; key: string };

// Large enough that a document splits a few dozen times, small enough that one
// chunk's block pass fits a frame's budget.
const CHUNK_CHARS = 16 * 1024;
const INLINE_BATCH = 64;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^#{1,6}(?:[ \t]|$)/;

/** Cut before a top-level heading that follows a blank line outside a fence: a
 *  heading always starts a new block, so no construct spans the cut. */
export function chunks(src: string): string[] {
  if (src.length <= CHUNK_CHARS) return [src];
  const out: string[] = [];
  let from = 0;
  let fence: string | null = null;
  let blank = true;
  let at = 0;
  while (at < src.length) {
    const end = src.indexOf("\n", at);
    const stop = end === -1 ? src.length : end + 1;
    const line = src.slice(at, stop);
    const open = FENCE.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
    } else if (open) {
      fence = open[1];
    } else if (blank && HEADING.test(line) && at - from >= CHUNK_CHARS) {
      out.push(src.slice(from, at));
      from = at;
    }
    blank = line.trim() === "";
    at = stop;
  }
  out.push(src.slice(from));
  return out;
}

export function* lexInSteps(text: string): Generator<void, PreviewBlock[]> {
  const lexer = new marked.Lexer();
  for (const chunk of chunks(text.replace(/\r\n?/g, "\n"))) {
    lexer.blockTokens(chunk, lexer.tokens);
    yield;
  }
  const queue = lexer.inlineQueue;
  for (let i = 0; i < queue.length; i++) {
    lexer.inlineTokens(queue[i].src, queue[i].tokens);
    if (i % INLINE_BATCH === INLINE_BATCH - 1) yield;
  }
  lexer.inlineQueue = [];
  return group(lexer.tokens);
}

function group(tokens: Token[]): PreviewBlock[] {
  const out: PreviewBlock[] = [];
  // Two identical blocks need two keys, or the view draws the one segment once.
  const seen = new Map<string, number>();
  const unique = (key: string) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${n}\0${key}`;
  };
  let run: Token[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push({ kind: "prose", tokens: run, key: unique("p\0" + run.map((r) => r.raw).join("")) });
    run = [];
  };
  for (const token of tokens) {
    if (token.type === "code") {
      flush();
      const lang = (token.lang ?? "").trim().split(/\s+/)[0];
      out.push({ kind: "code", lang, code: token.text, key: unique(`c\0${lang}\0${token.text}`) });
    } else {
      run.push(token);
    }
  }
  flush();
  return out;
}
