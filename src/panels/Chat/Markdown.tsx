import { Index, Match, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Token } from "marked";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { traceWork } from "../../utils/perfTrace";
import { emitWith, NAVIGATE, TOAST, type NavTarget, type ToastEvent } from "../../utils/events";
import { openPlaced, placeOf, type FilePlace } from "./filePlace";
import { linkTarget, pathTarget, pathWords } from "./links";
import { LINEWISE, PROSE } from "./chatMarked";
import CodeBlock from "./CodeBlock";
import styles from "./Chat.module.css";

type Segment = { kind: "prose"; html: string } | { kind: "code"; lang: string; code: string };

/** Paths known to exist. Only hits are kept: a file the agent writes after it
 *  first named it has to become a link on the next render. */
const existing = new Set<string>();

async function fileExists(path: string): Promise<boolean> {
  if (existing.has(path)) return true;
  const ok = await invoke<boolean>("file_exists", { path }).catch(() => false);
  if (ok) existing.add(path);
  return ok;
}

type Named = { path: string; line?: number; place: FilePlace };

/** A path from the reply placed against Tori's worktrees, or null when it is
 *  not a path or lives nowhere Tori tracks. Existence is the caller's check. */
function named(text: string, cwd: string): Named | null {
  const target = pathTarget(text, cwd);
  if (!target) return null;
  const place = target.outside ? placeOf(target.path, cwd) : ({ kind: "here" } as const);
  return place ? { path: target.path, line: target.line, place } : null;
}

/** Turn what in `root` names a file Tori can open into links: an inline code
 *  span that is a path, and a path written in the running text. Fenced code is
 *  a component of its own and never reaches here, and an anchor is a link
 *  already. */
function linkPaths(root: HTMLElement, cwd: string) {
  if (!cwd) return;
  for (const code of root.querySelectorAll<HTMLElement>("code")) {
    if (code.closest("pre, a") || code.dataset.path) continue;
    const target = named(code.textContent ?? "", cwd);
    if (!target) continue;
    void fileExists(target.path).then((ok) => {
      if (ok) markPath(code, target);
    });
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest("code, pre, a, [data-path]")) texts.push(n as Text);
  }
  for (const node of texts) {
    const found = pathWords(node.data).flatMap((w) => {
      const target = named(w.raw, cwd);
      return target ? [{ ...w, target }] : [];
    });
    if (!found.length) continue;
    void Promise.all(found.map((f) => fileExists(f.target.path))).then((oks) => {
      const source = node.data;
      if (!node.isConnected) return;
      // Back to front, so splitting off one match leaves the offsets of the
      // ones before it where they were.
      for (let i = found.length - 1; i >= 0; i--) {
        const f = found[i];
        if (!oks[i] || source.slice(f.start, f.start + f.raw.length) !== f.raw) continue;
        const word = node.splitText(f.start);
        word.splitText(f.raw.length);
        const span = document.createElement("span");
        word.replaceWith(span);
        span.append(word);
        markPath(span, f.target);
      }
    });
  }
}

function markPath(el: HTMLElement, target: Named) {
  el.dataset.path = target.path;
  if (target.line) el.dataset.line = String(target.line);
  if (target.place.kind === "worktree") {
    el.dataset.folder = target.place.folder;
    el.dataset.label = target.place.label;
    el.title = `Open in ${target.place.label}`;
  } else {
    el.title = "Open file";
  }
}

/** The place `markPath` wrote onto an element. */
function placeFrom(el: HTMLElement): FilePlace {
  const { folder, label } = el.dataset;
  return folder ? { kind: "worktree", folder, label: label ?? folder } : { kind: "here" };
}

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
export default function Markdown(props: { text: string; cwd: string; breaks?: boolean; onRendered?: () => void }) {
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
    const tokens = traceWork("md-lex", () => md.lexer(text()));
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

  createEffect(() => {
    segments();
    props.onRendered?.();
  });

  function onLinkClick(e: MouseEvent) {
    const marked = (e.target as Element | null)?.closest?.<HTMLElement>("[data-path]");
    if (marked) {
      const line = marked.dataset.line ? Number(marked.dataset.line) : undefined;
      return openPlaced(marked.dataset.path!, line, placeFrom(marked));
    }
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
      openPlaced(target.path, target.line, { kind: "here" });
    } else if (target.kind === "outside") {
      const place = placeOf(target.path, props.cwd);
      if (place) openPlaced(target.path, target.line, place);
      else emitWith<ToastEvent>(TOAST, { message: `${target.path} is outside this workspace.`, kind: "info" });
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
                ref={(el) => createEffect(on(s, () => linkPaths(el, props.cwd)))}
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
