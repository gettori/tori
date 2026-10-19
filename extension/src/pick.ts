export type Rect = { x: number; y: number; width: number; height: number };

export type Where = {
  chain: string[];
  props: Record<string, string> | null;
  source: string | null;
  testId: string;
  id: string;
  label: string;
};

export type Pick = {
  comment: string;
  kind: "element" | "selection";
  url: string;
  route: string;
  selector: string;
  path: string;
  html: string;
  text: string;
  styles: Record<string, string>;
  rect: Rect;
  viewport: { width: number; height: number };
  dpr: number;
  theme: "light" | "dark";
  where?: Where;
  images: string[];
  at: number;
};

export type LogKind = "error" | "warn" | "uncaught" | "rejection" | "request" | "overlay";

export type LogEntry = { seq: number; at: number; kind: LogKind; text: string; count: number };

// One event name both ways between the page log in the main world and the picker; `detail` is this, as JSON.
export type LogChannel = "tori:page-log";
export type LogMessage = { type: "ask" } | { type: "mark"; seq: number } | { type: "entries"; entries: LogEntry[] };

// The picker dispatches `ask` on the picked element and the inspect script in the
// main world answers on `document` before dispatchEvent returns; `detail` is this, as JSON.
export type InspectChannel = "tori:inspect";
export type InspectMessage =
  | { type: "ask"; sensitive: boolean }
  | { type: "found"; chain: string[]; props: Record<string, string> | null; source: string | null };

export type Chat = { id: string; title: string; agent: string };

export type Shot = { images: string[]; why?: string };

export type Sent = { title: string; logged: boolean } | { error: string };

export type Shortcut = { label: string; aria: string };

export type TrayState = {
  picks: Pick[];
  branch: string;
  shortcut: Shortcut | null;
  status: string | null;
  screenshots: boolean;
  pageLog: boolean;
};

export type PickerRequest = { type: "picker.toggle" } | { type: "picker.open" };

export type BatchRequest =
  | { type: "batch.get" }
  | { type: "batch.add"; pick: Pick }
  | { type: "batch.remove"; index: number }
  | { type: "batch.clear" }
  | { type: "shot"; rect: Rect; viewport: number }
  | { type: "markdown"; log: LogEntry[] }
  | { type: "chats" }
  | { type: "send"; chat: Chat | null; log: LogEntry[] }
  | { type: "reveal"; id: string }
  | { type: "options" }
  | { type: "screenshots" };

// Answered with null when Tori is reachable, otherwise the sentence saying why not.
export type ConnectionRequest = { type: "connection" };
