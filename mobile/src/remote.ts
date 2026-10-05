import { createSignal } from "solid-js";

export type Saved = { url: string; credential: string; id: string; name: string };

export type Status = "connecting" | "open" | "offline" | "revoked";

type Frame = {
  id?: number | null;
  method?: string;
  params?: { topic?: string; data?: unknown };
  result?: unknown;
  error?: { code: number; message: string };
};

const KEY = "tori-remote";
const INSTALL_KEY = "tori-install";

// The front answers an unknown credential with this; anything else before the
// close (the auth timeout on a slow link included) is a network failure.
const REVOKED = "wrong token";

// A dropped network can leave the socket half open with no close event (seen
// when Wi-Fi goes off under Tailscale), so an unanswered request or probe is
// what declares it dead.
const REPLY_MS = 10_000;
const PROBE_MS = 20_000;
// An attempt made as the network changes can sit unopened with no close event.
const CONNECT_MS = 10_000;

export const REFUSED_CODE = -32002;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export function loadSaved(): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    return saved?.url && saved.credential ? saved : null;
  } catch {
    return null;
  }
}

export function forget() {
  localStorage.removeItem(KEY);
}

// Outlives a disconnect, so pairing this phone again replaces its old entry on the Mac.
function installId(): string {
  const kept = localStorage.getItem(INSTALL_KEY);
  if (kept) return kept;
  const made = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(INSTALL_KEY, made);
  return made;
}

export function parsePairLink(text: string): { url: string; code: string } | null {
  const prefix = "tori://pair?";
  if (!text.startsWith(prefix)) return null;
  const params = new URLSearchParams(text.slice(prefix.length));
  const url = params.get("url");
  const code = params.get("code");
  return url && code ? { url, code } : null;
}

export function pair(url: string, code: string, name: string): Promise<Saved> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: 0, method: "pair", params: { code, name, install: installId() } }),
      );
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as Frame;
      done(() => {
        if (frame.error) return reject(new Error(frame.error.message));
        const paired = frame.result as { id: string; name: string; credential: string };
        const saved = { url, credential: paired.credential, id: paired.id, name: paired.name };
        localStorage.setItem(KEY, JSON.stringify(saved));
        resolve(saved);
      });
    };
    socket.onclose = (e) => done(() => reject(new Error(`the connection closed before an answer (${e.code})`)));
  });
}

export class RemoteClient {
  readonly status: () => Status;
  readonly generation: () => number;
  private setStatus: (s: Status) => void;
  private setGeneration: (n: number) => void;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private topics = new Map<string, Set<(data: unknown) => void>>();
  private retryMs = 1000;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private probe: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    readonly saved: Saved,
    private onRevoked: () => void,
  ) {
    const [status, setStatus] = createSignal<Status>("connecting");
    const [generation, setGeneration] = createSignal(0);
    this.status = status;
    this.generation = generation;
    this.setStatus = setStatus;
    this.setGeneration = setGeneration;
    this.connect();
  }

  request<T = unknown>(method: string, params: unknown = {}, replyMs = REPLY_MS): Promise<T> {
    if (this.status() !== "open" || !this.socket) return Promise.reject(new Error("not connected to Tori"));
    return this.send(this.socket, method, params, replyMs) as Promise<T>;
  }

  subscribe(topic: string, handler: (data: unknown) => void): () => void {
    let handlers = this.topics.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topics.set(topic, handlers);
      if (this.status() === "open" && this.socket) void this.send(this.socket, "subscribe", { topic }).catch(() => {});
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size > 0) return;
      this.topics.delete(topic);
      if (this.status() === "open" && this.socket)
        void this.send(this.socket, "unsubscribe", { topic }).catch(() => {});
    };
  }

  wake() {
    if (this.stopped) return;
    if (this.status() === "open") return void this.request("caller").catch(() => {});
    if (this.retry) clearTimeout(this.retry);
    const stale = this.socket;
    this.socket = null;
    stale?.close();
    this.retryMs = 1000;
    this.connect();
  }

  close() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const socket = this.socket;
    if (socket) this.drop(socket);
  }

  private send(socket: WebSocket, method: string, params: unknown, replyMs = REPLY_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.drop(socket), replyMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private connect() {
    this.retry = null;
    this.setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.saved.url);
    } catch {
      this.lost();
      return;
    }
    this.socket = socket;
    const unopened = setTimeout(() => socket.readyState === WebSocket.CONNECTING && this.drop(socket), CONNECT_MS);
    socket.onopen = () => {
      clearTimeout(unopened);
      this.send(socket, "auth", { token: this.saved.credential }).then(
        () => {
          this.retryMs = 1000;
          this.setStatus("open");
          this.probe = setInterval(() => void this.send(socket, "caller", null).catch(() => {}), PROBE_MS);
          for (const topic of this.topics.keys()) void this.send(socket, "subscribe", { topic }).catch(() => {});
          this.setGeneration(this.generation() + 1);
        },
        (e: Error) => {
          if (e.message === REVOKED) {
            this.stopped = true;
            this.setStatus("revoked");
            forget();
            this.onRevoked();
          }
          socket.close();
        },
      );
    };
    socket.onmessage = (message) => this.receive(JSON.parse(String(message.data)) as Frame);
    socket.onclose = () => {
      clearTimeout(unopened);
      if (this.socket === socket) this.lost();
    };
  }

  private receive(frame: Frame) {
    if (frame.method === "event") {
      const topic = frame.params?.topic;
      for (const handler of (topic && this.topics.get(topic)) || []) handler(frame.params?.data);
      return;
    }
    const waiting = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
    if (!waiting || typeof frame.id !== "number") return;
    clearTimeout(waiting.timer);
    this.pending.delete(frame.id);
    if (frame.error) waiting.reject(new RpcError(frame.error.message, frame.error.code));
    else waiting.resolve(frame.result);
  }

  private drop(socket: WebSocket) {
    socket.close();
    if (this.socket === socket) this.lost();
  }

  private lost() {
    this.socket = null;
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("the connection to Tori closed"));
    }
    this.pending.clear();
    if (this.stopped) return;
    this.setStatus("offline");
    this.retry = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }
}
