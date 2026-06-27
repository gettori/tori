import { onCleanup, onMount, createEffect } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let unlistenOut: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let ro: ResizeObserver | undefined;

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
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
      cursorBlink: true,
      allowProposedApi: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
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
    invoke("pty_kill", { id: props.id }).catch(() => {});
    term?.dispose();
  });

  return <div class="term-host" classList={{ hidden: !props.active }} ref={host} />;
}
