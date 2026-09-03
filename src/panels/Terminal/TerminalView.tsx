import { onCleanup, onMount, createEffect, createSignal, Show } from "solid-js";
import { Terminal, type ILink, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { acquireWebgl, type WebglSlot } from "./webglLru";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { on as onEvent, emitWith, FOCUS_TERMINAL, THEME_APPLIED, REFIT_PANES, OPEN_IN_EDITOR, DRAG_PATH_MIME, DRAG_ABS_PATH_MIME } from "../../utils/events";
import { dispatchHotkey } from "../../utils/hotkeys";
import { traceMark } from "../../utils/perfTrace";
import { findAdapter } from "../../utils/agents";
import { refusalMessage, refusalOf, type ClaimOutcome, type Refusal } from "../../utils/chatOwnership";
import { settings, terminalFontSize } from "../Settings/settingsStore";
import { ensureFontLoaded } from "../../utils/fontLoad";
import Button from "../../components/Button/Button";
import "@xterm/xterm/css/xterm.css";
import styles from "./Terminal.module.css";

/** `PtySpawnResult` from `src-tauri/src/pty.rs`. `ownership` is null for every
 *  tab that took no claim, which is most of them. */
type PtySpawnResult = { ownership: ClaimOutcome | null };

/** `pty://exit`'s payload. A null `code` is an exit the backend could not
 *  confirm within its wait, so it means "no clean exit proved", not zero. */
export type PtyExit = { id: string; code: number | null };

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
// be derived from --canvas-default/--fg-default (a program picks the slot, not us), so they are
// tokens too - see the --term-* ramps in styles/tokens.css. Re-read on
// THEME_APPLIED, which fires after <html>'s data-theme/inline props are set, so
// getComputedStyle already reflects the new theme.
function termColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim() || undefined;
  return {
    // Track the content-card surface (--canvas-card) rather than the desk (--canvas-default), so
    // the terminal reads as part of the card and recolouring the card token needs
    // no terminal change. (True transparency is avoided: the WebGL renderer
    // paints opaque black instead of compositing over the DOM behind it.)
    background: v("--canvas-card"),
    foreground: v("--fg-default"),
    cursor: v("--ansi-cursor"),
    cursorAccent: v("--canvas-card"),
    selectionBackground: v("--ansi-selection"),
    black: v("--ansi-black"),
    red: v("--ansi-red"),
    green: v("--ansi-green"),
    yellow: v("--ansi-yellow"),
    blue: v("--ansi-blue"),
    magenta: v("--ansi-magenta"),
    cyan: v("--ansi-cyan"),
    white: v("--ansi-white"),
    brightBlack: v("--ansi-bright-black"),
    brightRed: v("--ansi-bright-red"),
    brightGreen: v("--ansi-bright-green"),
    brightYellow: v("--ansi-bright-yellow"),
    brightBlue: v("--ansi-bright-blue"),
    brightMagenta: v("--ansi-bright-magenta"),
    brightCyan: v("--ansi-bright-cyan"),
    brightWhite: v("--ansi-bright-white"),
  };
}

/**
 * One xterm bound to one PTY session (props.id). Stays mounted while open so
 * the session keeps running; hidden via CSS when not the active tab.
 */
export default function TerminalView(props: {
  id: string;
  cwd: string;
  // `task` is shell-hosted like `shell`/`agent`: the backend branches on
  // `command` alone, so anything else gets the login shell and, if it carries
  // one, a backend-once `init`.
  kind: "shell" | "agent" | "command" | "task";
  program: string;
  args: string[];
  init?: string;
  /** Extra environment for this tab's process. Only a sign-in tab carries one:
   *  the profile's home variable, which is what makes the agent write its
   *  credentials into that account's home rather than the default one. */
  env?: Record<string, string>;
  // The agent session this tab resumes. Absent for shell/command tabs and for a
  // fresh agent tab, whose session id does not exist until the agent writes a
  // transcript. When present the backend claims it, so one session id can never
  // be driven by a terminal tab and a chat tab at once - two drivers append both
  // sides of a diverging conversation to one file.
  sessionId?: string;
  active: boolean;
  /** The session id was refused: something else already drives it, so nothing
   *  was spawned. The owner renders the way out, because only it can focus
   *  another tab or open a fresh session. */
  onOwnershipRefused?: (refusal: Refusal) => void;
}) {
  let host!: HTMLDivElement;
  let searchInput: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let webgl: WebglSlot | undefined;
  let linkProvider: IDisposable | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let ro: ResizeObserver | undefined;
  let settleTimer: number | undefined;
  let offFocus: (() => void) | undefined;
  let offTheme: (() => void) | undefined;
  let offRefit: (() => void) | undefined;
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

  // Both fits on the reveal path stay (an observer tick can miss a display:none
  // -> block flip). What goes is the round trip: `fit.fit()` already no-ops on
  // an unchanged grid, but `pty_resize` went out anyway, twice per tab click.
  function fitNow() {
    if (!term || !fit || !props.active || host.offsetParent === null) return;
    traceMark("term:fit");
    const want = fit.proposeDimensions();
    if (!want || (want.cols === term.cols && want.rows === term.rows)) {
      traceMark("term:fit-same");
      return;
    }
    fit.fit();
    traceMark("term:fitted");
    invoke("pty_resize", { id: props.id, cols: term.cols, rows: term.rows }).catch(
      () => {},
    );
  }

  // A single fit + pty_resize reflows the whole xterm buffer and round-trips to
  // the backend, so running it every frame of a splitter drag stutters. While a
  // drag is in progress (body.dragging), coalesce to one fit after motion
  // settles; otherwise (window resize, layout change) fit immediately.
  function onResizeObserved() {
    if (settleTimer) clearTimeout(settleTimer);
    if (document.body.classList.contains("dragging")) {
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        fitNow();
      }, 80);
    } else {
      fitNow();
    }
  }

  onMount(async () => {
    // Before anything measures a cell. xterm lays its grid on one measurement of
    // this font and tells the pty the resulting size, so measuring the fallback
    // while the bundled face is still loading gets both wrong at once.
    await ensureFontLoaded(settings.typography.terminalFontFamily, terminalFontSize());

    term = new Terminal({
      fontFamily: settings.typography.terminalFontFamily,
      fontSize: terminalFontSize(),
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
    term.open(host);

    // WebGL renderer, held by a page-wide LRU rather than owned here: contexts
    // are capped across the app, kept for the last few terminals to have been
    // on screen, and re-attached after a loss instead of falling back to the
    // DOM renderer for good. Attaching is a reveal, so a tab that mounts
    // hidden pays nothing.
    webgl = acquireWebgl(term, host);
    if (props.active) webgl.reveal();

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
    unlistenExit = await listen<PtyExit>("pty://exit", (e) => {
      if (e.payload.id === props.id && props.kind === "command") {
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
    const quietMs = props.kind === "agent" ? findAdapter(props.program).pty_quiet_ms : null;

    const spawned = await invoke<PtySpawnResult>("pty_spawn", {
      id: props.id,
      program: props.program,
      args: props.args,
      cwd: props.cwd,
      cols: term.cols,
      rows: term.rows,
      kind: props.kind,
      init: props.init ?? null,
      quietMs,
      env: props.env ? Object.entries(props.env) : null,
      sessionId: props.kind === "agent" ? (props.sessionId ?? null) : null,
      agentId: props.kind === "agent" ? props.program : null,
      onOutput: output,
    }).catch((err) => {
      term?.writeln(`\r\n\x1b[31mfailed to start: ${err}\x1b[0m`);
      return null;
    });
    // A refused claim is a value, not a thrown error: nothing was spawned, and
    // the answer is structural (go to the tab that holds it, or end the
    // leftover process), which a line printed into a dead terminal cannot be.
    const refusal = refusalOf(spawned?.ownership);
    if (refusal) {
      term?.writeln(`\r\n\x1b[33m${refusalMessage(refusal)}\x1b[0m`);
      props.onOwnershipRefused?.(refusal);
    }

    ro = new ResizeObserver(onResizeObserved);
    ro.observe(host);
    if (props.active) term.focus();

    offFocus = onEvent(FOCUS_TERMINAL, () => {
      if (props.active) term?.focus();
    });
    offTheme = onEvent(THEME_APPLIED, () => {
      if (term) term.options.theme = termColors();
    });
    // A pane was just revealed: refit now (the active view only) rather than
    // waiting on a ResizeObserver tick a display:none -> block flip can miss.
    offRefit = onEvent(REFIT_PANES, () => {
      if (props.active) queueMicrotask(fitNow);
    });
  });

  // Live font: xterm is canvas/WebGL, so CSS can't reach it - push the effective
  // size (base setting × global zoom) and the terminal font family through its
  // API, then refit so the cell grid and pty dimensions follow. Runs once term
  // exists and again on every zoom/font change; initial values are set at
  // construction above.
  createEffect(() => {
    const size = terminalFontSize();
    const family = settings.typography.terminalFontFamily;
    if (term && (term.options.fontSize !== size || term.options.fontFamily !== family)) {
      term.options.fontSize = size;
      term.options.fontFamily = family;
      fitNow();
      // A family typed in Settings can be one the page has not loaded yet, and
      // the fit above then measured whatever was available. Fit again once the
      // face is real; a font already loaded resolves on the spot and this is a
      // second fit of the same numbers.
      void ensureFontLoaded(family, size).then(fitNow);
    }
  });

  // Fit + focus whenever this view becomes the active tab, and tell the WebGL
  // cap which side of the edge this is. `active` is a per-tab memo (phase 3),
  // so both branches run on real edges only.
  createEffect(() => {
    if (props.active) {
      traceMark("term:reveal");
      webgl?.reveal();
      traceMark("term:revealed");
      queueMicrotask(() => {
        fitNow();
        term?.focus();
        traceMark("term:focused");
      });
    } else {
      webgl?.conceal();
    }
  });

  onCleanup(() => {
    linkProvider?.dispose();
    unlistenExit?.();
    ro?.disconnect();
    if (settleTimer) clearTimeout(settleTimer);
    offFocus?.();
    offTheme?.();
    offRefit?.();
    invoke("pty_kill", { id: props.id }).catch(() => {});
    // Before term.dispose(), which drops the addon without releasing its
    // context and would leave the cap counting one that no longer exists.
    webgl?.release();
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
          <Button variant="ghost" size="xs" aria-label="Previous" tooltip="Previous" onClick={() => find(false)}>↑</Button>
          <Button variant="ghost" size="xs" aria-label="Next" tooltip="Next" onClick={() => find(true)}>↓</Button>
          <Button variant="ghost" size="xs" aria-label="Close" tooltip="Close" onClick={closeSearch}>×</Button>
        </div>
      </Show>
      <div class={styles.termHost} ref={host} />
    </div>
  );
}
