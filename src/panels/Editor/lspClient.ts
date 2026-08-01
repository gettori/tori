// Bridges @codemirror/lsp-client to the Rust-hosted typescript-language-server.
// The Transport is JSON-message based: send -> lsp_send (Rust frames it onto the
// server's stdin); incoming frames arrive de-framed over a Tauri Channel from
// lsp_start and are fanned out to subscribers. One client per project (rebuilt
// on project switch).

import { Channel, invoke } from "@tauri-apps/api/core";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { isUnderPath } from "../../utils/pathScope";

const LSP_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);

let client: LSPClient | null = null;
let currentRoot: string | null = null;
let starting: Promise<LSPClient | null> | null = null;

// Notified whenever `client` changes identity: it comes up, it is torn down, or
// a project switch replaces it. A buffer resolves its LSP extension once, when
// its EditorState is built, so without a signal here every file opened before
// the server was ready would stay LSP-less until it was closed and reopened.
let watchers: (() => void)[] = [];

/** Subscribe to client lifecycle changes. Returns an unsubscribe. */
export function onLspChange(cb: () => void): () => void {
  watchers.push(cb);
  return () => {
    watchers = watchers.filter((w) => w !== cb);
  };
}

// The one place `client` is assigned, so no transition can skip the notify.
// Iterates a copy: a watcher is allowed to unsubscribe from inside its own call.
function setClient(next: LSPClient | null) {
  if (client === next) return;
  client = next;
  for (const w of [...watchers]) w();
}

/** Start (or reuse) the language server + client for a project root. */
export function ensureLsp(root: string): Promise<LSPClient | null> {
  if (client && currentRoot === root) return Promise.resolve(client);
  if (starting && currentRoot === root) return starting;
  currentRoot = root;
  starting = (async () => {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
      // Notified before the new client exists, so open buffers drop the dead
      // plugin rather than holding one that points at a disconnected server.
      setClient(null);
    }
    await invoke("lsp_stop").catch(() => {});

    let handlers: ((value: string) => void)[] = [];
    const channel = new Channel<string>();
    channel.onmessage = (msg) => {
      for (const h of handlers) h(msg);
    };
    const transport: Transport = {
      send: (message) => void invoke("lsp_send", { message }).catch(() => {}),
      subscribe: (h) => handlers.push(h),
      unsubscribe: (h) => {
        handlers = handlers.filter((x) => x !== h);
      },
    };

    try {
      await invoke("lsp_start", { projectPath: root, onMessage: channel });
    } catch (e) {
      console.error("lsp_start failed", e);
      return null;
    }
    // Server stays silent until it receives `initialize`, which connect() sends,
    // so no messages are missed between lsp_start and subscribing here.
    setClient(
      new LSPClient({
        rootUri: `file://${root}`,
        extensions: languageServerExtensions(),
      }).connect(transport),
    );
    return client;
  })();
  return starting;
}

/** Per-buffer editor extension for a TS/JS file under the active project root,
 *  empty for anything else. Empty while the client is still starting too, which
 *  is why callers hold it in a compartment and reconfigure on `onLspChange`
 *  rather than baking the result into the buffer's state. */
export function lspPluginFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!client || !LSP_EXTS.has(ext)) return [];
  // The Docs tree and a worktree's `.shared/` open real files from outside the
  // project the server was started for. Handing one to this server would have
  // it answer from the wrong project's tsconfig, so it gets no plugin at all.
  if (!currentRoot || !isUnderPath(path, currentRoot)) return [];
  return client.plugin(`file://${path}`);
}
