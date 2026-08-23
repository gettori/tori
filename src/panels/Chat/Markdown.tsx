import { Index, Match, Switch, createMemo } from "solid-js";
import { marked, type Token } from "marked";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";
import { linkTarget } from "./links";
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
 *
 * Links are routed rather than followed. `sanitizeHtml` leaves anchors alone -
 * they are not a script vector - but an anchor the webview follows takes the
 * whole app off the SPA, which reads as a crash and loses the session. So every
 * click is intercepted, and where it goes is `linkTarget`'s answer.
 */
export default function Markdown(props: { text: string; cwd: string }) {
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

  function onLinkClick(e: MouseEvent) {
    const anchor = (e.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    // Before the switch, not inside it: an href this cannot place must still
    // not be followed.
    e.preventDefault();
    const target = linkTarget(anchor.getAttribute("href") ?? "", props.cwd);
    if (target.kind === "external") {
      // Through the opener plugin rather than `window.open`, which the webview
      // is free to answer by navigating.
      void invoke("plugin:opener|open_url", { url: target.url }).catch(() => {});
    } else if (target.kind === "file") {
      emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: target.path, line: target.line });
    } else if (target.kind === "outside") {
      emitWith<ToastEvent>(TOAST, { message: `${target.path} is outside this workspace.`, kind: "info" });
    }
  }

  // `Index`, not `For`: segments are positional. While streaming, positions
  // keep their DOM and only a segment whose content changed updates.
  return (
    <Index each={segments()}>
      {(seg) => (
        <Switch>
          <Match when={seg().kind === "prose" && seg()}>
            {(s) => (
              // The handler sits on the prose block rather than a wrapper: the
              // transcript's spacing rules select `.mdProse` as a direct child
              // of `.assistant`, so an extra element would break them.
              <div
                class={styles.mdProse}
                onClick={onLinkClick}
                innerHTML={(s() as Extract<Segment, { kind: "prose" }>).html}
              />
            )}
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
