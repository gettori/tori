import { onCleanup, onMount, createEffect, createSignal, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { on as onEvent, FOCUS_TERMINAL, THEME_APPLIED } from "../events";
import "@xterm/xterm/css/xterm.css";

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function termColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return { background: v("--bg", "#1e1e1e"), foreground: v("--text", "#d4d4d4") };
}

/**
 * One xterm bound to one PTY session (props.id). Stays mounted while open so
 * the session keeps running; hidden via CSS when not the active tab.
 */
export default function TerminalView(props: {
  id: string;
  cwd: string;
  program: string;
  args: string[];
  active: boolean;
}) {
  let host!: HTMLDivElement;
  let searchInput: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let unlistenOut: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let ro: ResizeObserver | undefined;
  let offFocus: (() => void) | undefined;
  let offTheme: (() => void) | undefined;
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
    term.loadAddon(new SerializeAddon());
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

    // ⌘F opens the in-terminal search (return false so xterm/browser ignore it).
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && e.key === "f" && e.type === "keydown") {
        e.preventDefault();
        openSearch();
        return false;
      }
      return true;
    });

    fit.fit();

    term.onData((data) => {
      invoke("pty_write", { id: props.id, data }).catch(() => {});
    });

    unlistenOut = await listen<{ id: string; data: string }>("pty://output", (e) => {
      if (e.payload.id === props.id) term?.write(decodeBase64(e.payload.data));
    });
    unlistenExit = await listen<string>("pty://exit", (e) => {
      if (e.payload === props.id) {
        term?.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
      }
    });

    await invoke("pty_spawn", {
      id: props.id,
      program: props.program,
      args: props.args,
      cwd: props.cwd,
      cols: term.cols,
      rows: term.rows,
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
    unlistenOut?.();
    unlistenExit?.();
    ro?.disconnect();
    offFocus?.();
    offTheme?.();
    invoke("pty_kill", { id: props.id }).catch(() => {});
    term?.dispose();
  });

  return (
    <div class="term-host-wrap" classList={{ hidden: !props.active }}>
      <Show when={showSearch()}>
        <div class="term-search">
          <input
            ref={searchInput}
            class="term-search-input"
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
          <button onClick={() => find(false)} title="Previous">↑</button>
          <button onClick={() => find(true)} title="Next">↓</button>
          <button onClick={closeSearch} title="Close">×</button>
        </div>
      </Show>
      <div class="term-host" ref={host} />
    </div>
  );
}
