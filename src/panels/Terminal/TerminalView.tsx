import { onCleanup, onMount, createEffect, createSignal, Show } from "solid-js";
import { Terminal, type ILink, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { on as onEvent, emitWith, FOCUS_TERMINAL, THEME_APPLIED, OPEN_IN_EDITOR, DRAG_PATH_MIME, DRAG_ABS_PATH_MIME } from "../../utils/events";
import { dispatchHotkey } from "../../utils/hotkeys";
import { findAgent } from "../../utils/agents";
import { registerPeek } from "../../utils/termPeek";
import Button from "../../components/Button/Button";
import "@xterm/xterm/css/xterm.css";
import styles from "./Terminal.module.css";

// File paths in terminal output, with optional :line:col. Requires an extension
// so it doesn't match arbitrary words; existence is validated before linking.
const PATH_RE = /[\w.\-~/]+\.\w+(?::\d+(?::\d+)?)?/g;

// PTY output arrives over a Tauri Channel as raw bytes (an ArrayBuffer), or as a
// Uint8Array/number[] depending on transport; normalize to what xterm.write takes.
function toBytes(msg: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (msg instanceof Uint8Array) return msg;
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  return new Uint8Array(msg);
}

// xterm's ITheme, read entirely from the token layer. The 16 ANSI slots cannot
// be derived from --bg/--text (a program picks the slot, not us), so they are
// tokens too - see the --term-* ramps in styles/tokens.css. Re-read on
// THEME_APPLIED, which fires after <html>'s data-theme/inline props are set, so
// getComputedStyle already reflects the new theme.
function termColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim() || undefined;
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--term-cursor"),
    cursorAccent: v("--bg"),
    selectionBackground: v("--term-selection"),
    black: v("--term-black"),
    red: v("--term-red"),
    green: v("--term-green"),
    yellow: v("--term-yellow"),
    blue: v("--term-blue"),
    magenta: v("--term-magenta"),
    cyan: v("--term-cyan"),
    white: v("--term-white"),
    brightBlack: v("--term-bright-black"),
    brightRed: v("--term-bright-red"),
    brightGreen: v("--term-bright-green"),
    brightYellow: v("--term-bright-yellow"),
    brightBlue: v("--term-bright-blue"),
    brightMagenta: v("--term-bright-magenta"),
    brightCyan: v("--term-bright-cyan"),
    brightWhite: v("--term-bright-white"),
  };
}

/**
 * One xterm bound to one PTY session (props.id). Stays mounted while open so
 * the session keeps running; hidden via CSS when not the active tab.
 */
export default function TerminalView(props: {
  id: string;
  cwd: string;
  kind: "shell" | "agent" | "command";
  program: string;
  args: string[];
  init?: string;
  active: boolean;
}) {
  let host!: HTMLDivElement;
  let searchInput: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let linkProvider: IDisposable | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let ro: ResizeObserver | undefined;
  let offFocus: (() => void) | undefined;
  let offTheme: (() => void) | undefined;
  let unregisterPeek: (() => void) | undefined;
  const [showSearch, setShowSearch] = createSignal(false);
  const [query, setQuery] = createSignal("");

  function openSearch() {
    setShowSearch(true);
  }
  function closeSearch() {
    setShowSearch(false);
    term?.focus();
  }
  function find(next: boolean) {
    const q = query();
    if (!q) return;
    if (next) search?.findNext(q);
    else search?.findPrevious(q);
  }

  // Dropping onto the terminal inserts the dragged path(s) as `@path ` at the
  // prompt (written to the PTY as if typed). Left-sidebar rows carry one or more
  // newline-separated ABSOLUTE paths (inserted verbatim); file-tree rows / editor
  // tabs carry a single path that is relativized to the session cwd.
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const abs = e.dataTransfer?.getData(DRAG_ABS_PATH_MIME) || "";
    if (abs) {
      const mention = abs
        .split("\n")
        .filter(Boolean)
        .map((p) => `@${p}`)
        .join(" ");
      if (mention) invoke("pty_write", { id: props.id, data: `${mention} ` }).catch(() => {});
      term?.focus();
      return;
    }
    const path =
      e.dataTransfer?.getData(DRAG_PATH_MIME) || e.dataTransfer?.getData("text/plain") || "";
    if (!path) return;
    const rel = path.startsWith(props.cwd + "/") ? path.slice(props.cwd.length + 1) : path;
    invoke("pty_write", { id: props.id, data: `@${rel} ` }).catch(() => {});
    term?.focus();
  }

  // Focus the search box when it appears.
  createEffect(() => {
    if (showSearch()) queueMicrotask(() => searchInput?.focus());
  });

  function fitNow() {
    if (!term || !fit || !props.active || host.offsetParent === null) return;
    fit.fit();
    invoke("pty_resize", { id: props.id, cols: term.cols, rows: term.rows }).catch(
      () => {},
    );
  }

  onMount(async () => {
    term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
      fontSize: 13,
      theme: termColors(),
      cursorBlink: true,
      allowProposedApi: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    search = new SearchAddon();
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new ClipboardAddon());
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    // Expose a buffer reader for the tab strip's hover peek. Only the visible
    // screen is serialized (no scrollback): the peek shows the last few lines,
    // and serializing a full scrollback on every hover would be wasted work.
    unregisterPeek = registerPeek(props.id, () => serialize.serialize({ scrollback: 0 }));
    term.open(host);

    // WebGL renderer, with a one-time fallback to the DOM renderer if the GL
    // context is lost (disposing the addon makes xterm fall back automatically).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable: xterm keeps the DOM renderer.
    }

    // Clickable file paths: match path-like tokens on a line, validate each via
    // file_exists (so non-existent paths aren't linked), and on click open the
    // file in CM6 at the optional :line:col, resolved against the session cwd.
    linkProvider = term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const text = term?.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const matches: { token: string; index: number }[] = [];
        for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
          matches.push({ token: m[0], index: m.index });
        }
        PATH_RE.lastIndex = 0;
        if (!matches.length) return callback(undefined);
        Promise.all(
          matches.map(async ({ token, index }): Promise<ILink | null> => {
            const [filePart, lineStr, colStr] = token.split(":");
            const abs = filePart.startsWith("/") ? filePart : `${props.cwd}/${filePart}`;
            const ok = await invoke<boolean>("file_exists", { path: abs }).catch(() => false);
            if (!ok) return null;
            return {
              range: { start: { x: index + 1, y }, end: { x: index + token.length, y } },
              text: token,
              activate: () =>
                emitWith(OPEN_IN_EDITOR, {
                  path: abs,
                  line: lineStr ? Number(lineStr) : undefined,
                  col: colStr ? Number(colStr) : undefined,
                }),
            };
          }),
        ).then((links) => callback(links.filter((l): l is ILink => l !== null)));
      },
    });

    // ⌘F opens the in-terminal search; the global remap (Cmd+1..9, Ctrl+Tab,
    // Cmd+Shift+A/E/F, Cmd+J/K) is re-dispatched here too, since an xterm
    // textarea's keydown never reaches the window listener via xterm's own
    // handling once it has focus (adversary E3). Both branches call
    // stopPropagation(), not just preventDefault(): xterm's custom-key-handler
    // return value only tells xterm itself to ignore the key, it doesn't stop
    // the native event from continuing to bubble up to window - without this,
    // App.tsx's own keydown listener would fire a second time on the same
    // keystroke (e.g. Cmd+Shift+A would skip two waiting sessions, not one).
    // ⌘Shift+F is excluded from the ⌘F branch so it falls through to
    // dispatchHotkey's project-search binding instead.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.metaKey && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return false;
      }
      if (dispatchHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });

    fit.fit();

    term.onData((data) => {
      invoke("pty_write", { id: props.id, data }).catch(() => {});
    });

    // Only command tabs stay visible after exit, so only they print this. A
    // shell/agent tab is removed by Terminal.tsx on exit, so it would never show.
    unlistenExit = await listen<string>("pty://exit", (e) => {
      if (e.payload === props.id && props.kind === "command") {
        term?.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
      }
    });

    // Per-session output channel (replaces the global base64 pty://output event).
    // A fresh channel each mount; the Rust side rewires it to the live session.
    const output = new Channel<ArrayBuffer | Uint8Array | number[]>();
    output.onmessage = (msg) => term?.write(toBytes(msg));

    // Agent tabs use their adapter's own (empirically measured) quiet
    // threshold for the pty://activity working/needs-you pulse; shell/command
    // tabs fall back to the backend's default.
    const quietMs = props.kind === "agent" ? findAgent(props.program).pty_quiet_ms : null;

    await invoke("pty_spawn", {
      id: props.id,
      program: props.program,
      args: props.args,
      cwd: props.cwd,
      cols: term.cols,
      rows: term.rows,
      kind: props.kind,
      init: props.init ?? null,
      quietMs,
      onOutput: output,
    }).catch((err) => term?.writeln(`\r\n\x1b[31mfailed to start: ${err}\x1b[0m`));

    ro = new ResizeObserver(() => fitNow());
    ro.observe(host);
    if (props.active) term.focus();

    offFocus = onEvent(FOCUS_TERMINAL, () => {
      if (props.active) term?.focus();
    });
    offTheme = onEvent(THEME_APPLIED, () => {
      if (term) term.options.theme = termColors();
    });
  });

  // Fit + focus whenever this view becomes the active tab.
  createEffect(() => {
    if (props.active) {
      queueMicrotask(() => {
        fitNow();
        term?.focus();
      });
    }
  });

  onCleanup(() => {
    linkProvider?.dispose();
    unlistenExit?.();
    ro?.disconnect();
    offFocus?.();
    offTheme?.();
    unregisterPeek?.();
    invoke("pty_kill", { id: props.id }).catch(() => {});
    term?.dispose();
  });

  return (
    <div
      class={styles.termHostWrap}
      classList={{ [styles.hidden]: !props.active }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={handleDrop}
    >
      <Show when={showSearch()}>
        <div class={styles.termSearch}>
          <input
            ref={searchInput}
            class={styles.termSearchInput}
            placeholder="Find"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              search?.findNext(e.currentTarget.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                find(!e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <Button variant="ghost" size="xs" aria-label="Previous" title="Previous" onClick={() => find(false)}>↑</Button>
          <Button variant="ghost" size="xs" aria-label="Next" title="Next" onClick={() => find(true)}>↓</Button>
          <Button variant="ghost" size="xs" aria-label="Close" title="Close" onClick={closeSearch}>×</Button>
        </div>
      </Show>
      <div class={styles.termHost} ref={host} />
    </div>
  );
}
