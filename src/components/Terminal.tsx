import { onCleanup, onMount, createSignal } from "solid-js";
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

export default function TerminalPane() {
  let host!: HTMLDivElement;
  const [cwd, setCwd] = createSignal("/Users/skarif/GRIMOIRE");
  const [sessionId, setSessionId] = createSignal("");
  const [running, setRunning] = createSignal(false);

  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let unlistenOut: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let ro: ResizeObserver | undefined;

  function doFit() {
    if (!term || !fit) return;
    fit.fit();
    invoke("pty_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
  }

  async function start() {
    if (!term || !fit) return;
    term.reset();
    const id = sessionId().trim();
    const args = id ? ["--resume", id] : [];
    fit.fit();
    try {
      await invoke("pty_spawn", {
        program: "claude",
        args,
        cwd: cwd(),
        cols: term.cols,
        rows: term.rows,
      });
      setRunning(true);
    } catch (e) {
      term.writeln(`\r\n\x1b[31mfailed to start: ${e}\x1b[0m`);
    }
  }

  async function stop() {
    await invoke("pty_kill").catch(() => {});
    setRunning(false);
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
      invoke("pty_write", { data }).catch(() => {});
    });

    unlistenOut = await listen<string>("pty://output", (e) => {
      term?.write(decodeBase64(e.payload));
    });
    unlistenExit = await listen("pty://exit", () => {
      setRunning(false);
      term?.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    });

    ro = new ResizeObserver(() => doFit());
    ro.observe(host);
  });

  onCleanup(() => {
    unlistenOut?.();
    unlistenExit?.();
    ro?.disconnect();
    invoke("pty_kill").catch(() => {});
    term?.dispose();
  });

  return (
    <div class="term-wrap">
      <div class="term-bar">
        <input
          class="term-input cwd"
          value={cwd()}
          onInput={(e) => setCwd(e.currentTarget.value)}
          placeholder="project cwd"
        />
        <input
          class="term-input sid"
          value={sessionId()}
          onInput={(e) => setSessionId(e.currentTarget.value)}
          placeholder="session id (blank = new)"
        />
        {running() ? (
          <button class="term-btn stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button class="term-btn" onClick={start}>
            Start Claude
          </button>
        )}
      </div>
      <div class="term-host" ref={host} />
    </div>
  );
}
