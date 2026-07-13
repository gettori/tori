// Bridges @codemirror/lsp-client to the Rust-hosted typescript-language-server.
// The Transport is JSON-message based: send -> lsp_send (Rust frames it onto the
// server's stdin); incoming frames arrive de-framed over a Tauri Channel from
// lsp_start and are fanned out to subscribers. One client per project (rebuilt
// on project switch).

import { Channel, invoke } from "@tauri-apps/api/core";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";

const LSP_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);

let client: LSPClient | null = null;
let currentRoot: string | null = null;
let starting: Promise<LSPClient | null> | null = null;

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
      client = null;
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
    client = new LSPClient({
      rootUri: `file://${root}`,
      extensions: languageServerExtensions(),
    }).connect(transport);
    return client;
  })();
  return starting;
}

/** Per-buffer editor extension for a TS/JS file (empty for other types or until
 *  the client is ready; reopen the file to attach LSP if it opened too early). */
export function lspPluginFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!client || !LSP_EXTS.has(ext)) return [];
  return client.plugin(`file://${path}`);
}
