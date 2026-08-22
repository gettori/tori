import { Index, Match, Switch, createMemo } from "solid-js";
import { marked, type Token } from "marked";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import CodeBlock from "./CodeBlock";
import styles from "./Chat.module.css";

type Segment =
  | { kind: "prose"; html: string }
  | { kind: "code"; lang: string; code: string };

/**
 * Assistant markdown, rendered block by block rather than as one innerHTML
 * blob. That is what makes streaming cheap - a delta re-renders only the tail
 * segment, everything above it is untouched DOM - and it is what lets a code
 * fence be a real component with controls instead of inert markup.
 *
 * Assistant text is model output, so the prose segments get the same
 * treatment as a local markdown file: rendered locally with `marked`, then
 * stripped of script-execution vectors before going near innerHTML. Fence
 * contents never become markup at all, so they need no sanitizing.
 */
export default function Markdown(props: { text: string }) {
  // Rendered prose keyed by its raw source, carried across recomputes: while
  // streaming, every segment but the tail hits this cache, so the per-delta
  // cost is one lexer pass plus one segment's parse and sanitize.
  let prev = new Map<string, string>();

  const segments = createMemo<Segment[]>(() => {
    const tokens = marked.lexer(props.text);
    const next = new Map<string, string>();
    const segs: Segment[] = [];
    let run: Token[] = [];
    const flush = () => {
      if (!run.length) return;
      const raw = run.map((t) => t.raw).join("");
      const html = prev.get(raw) ?? next.get(raw) ?? sanitizeHtml(marked.parser(run));
      next.set(raw, html);
      segs.push({ kind: "prose", html });
      run = [];
    };
    for (const t of tokens) {
      if (t.type === "code") {
        flush();
        segs.push({ kind: "code", lang: (t.lang ?? "").trim().split(/\s+/)[0], code: t.text });
      } else {
        run.push(t);
      }
    }
    flush();
    prev = next;
    return segs;
  });

  // `Index`, not `For`: segments are positional. While streaming, positions
  // keep their DOM and only a segment whose content changed updates.
  return (
    <Index each={segments()}>
      {(seg) => (
        <Switch>
          <Match when={seg().kind === "prose" && seg()}>
            {(s) => <div class={styles.mdProse} innerHTML={(s() as Extract<Segment, { kind: "prose" }>).html} />}
          </Match>
          <Match when={seg().kind === "code" && seg()}>
            {(s) => {
              const code = () => s() as Extract<Segment, { kind: "code" }>;
              return <CodeBlock lang={code().lang} code={code().code} />;
            }}
          </Match>
        </Switch>
      )}
    </Index>
  );
}
