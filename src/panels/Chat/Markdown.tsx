import { Index, Match, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Token } from "marked";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { emitWith, NAVIGATE, OPEN_IN_EDITOR, TOAST, type NavTarget, type OpenInEditor, type ToastEvent } from "../../utils/events";
import { linkTarget } from "./links";
import { LINEWISE, PROSE } from "./chatMarked";
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
 * Assistant text is model output, so raw HTML in it is shown as the text it
 * is, a remote image becomes a link, and what `marked` renders is sanitized
 * before going near innerHTML. Fence contents never become markup at all, so
 * they need no sanitizing.
 *
 * Links are routed rather than followed. `sanitizeHtml` leaves anchors alone -
 * they are not a script vector - but an anchor the webview follows takes the
 * whole app off the SPA, which reads as a crash and loses the session. So every
 * click is intercepted, and where it goes is `linkTarget`'s answer.
 *
 * `breaks` turns a single newline into a line break, and is off for anything a
 * model wrote: the model writes markdown, where a wrapped paragraph is one
 * paragraph and honouring its newlines would shred it. What needs it is text
 * that only looks like markdown. `/usage` answers in plain lines whose breaks
 * are the whole structure, and rendering those as prose ran the session, the
 * week and the per-model rows together into one sentence.
 */
export default function Markdown(props: { text: string; cwd: string; breaks?: boolean }) {
  // Rendered prose keyed by its raw source, carried across recomputes: while
  // streaming, every segment but the tail hits this cache, so the per-delta
  // cost is one lexer pass plus one segment's parse and sanitize.
  let prev = new Map<string, string>();

  // The lexer below reads the whole message, so a delta per token is quadratic
  // over a long answer. The first change after a quiet frame lands at once;
  // the rest of that frame's deltas land together on the next one.
  const [text, setText] = createSignal(props.text);
  let frame: number | undefined;
  const settle = () => {
    frame = undefined;
    if (props.text === text()) return;
    setText(props.text);
    frame = requestAnimationFrame(settle);
  };
  createEffect(
    on(
      () => props.text,
      (next) => {
        if (typeof requestAnimationFrame === "undefined") return setText(next);
        if (frame !== undefined) return;
        setText(next);
        frame = requestAnimationFrame(settle);
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  const segments = createMemo<Segment[]>(() => {
    // One instance for both halves, or they disagree about what a newline is:
    // the lexer decides whether one becomes a break token, the parser decides
    // whether it renders.
    const md = props.breaks === true ? LINEWISE : PROSE;
    const tokens = md.lexer(text());
    const next = new Map<string, string>();
    const segs: Segment[] = [];
    let run: Token[] = [];
    const flush = () => {
      if (!run.length) return;
      const raw = run.map((t) => t.raw).join("");
      const html = prev.get(raw) ?? next.get(raw) ?? sanitizeHtml(md.parser(run));
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
    } else if (target.kind === "navigate") {
      emitWith<NavTarget>(NAVIGATE, target.target);
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
