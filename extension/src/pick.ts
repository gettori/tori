export type Rect = { x: number; y: number; width: number; height: number };

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
  images: string[];
};

export type Chat = { id: string; title: string; agent: string };

export type Shot = { images: string[]; why?: string };

export type Sent = { title: string } | { error: string };

export type Shortcut = { label: string; aria: string };

export type TrayState = {
  picks: Pick[];
  branch: string;
  shortcut: Shortcut | null;
  status: string | null;
  screenshots: boolean;
};

export type PickerRequest = { type: "picker.toggle" } | { type: "picker.open" };

export type BatchRequest =
  | { type: "batch.get" }
  | { type: "batch.add"; pick: Pick }
  | { type: "batch.remove"; index: number }
  | { type: "batch.clear" }
  | { type: "shot"; rect: Rect; viewport: number }
  | { type: "markdown" }
  | { type: "chats" }
  | { type: "send"; chat: Chat | null }
  | { type: "reveal"; id: string }
  | { type: "options" }
  | { type: "screenshots" };

// Answered with null when Tori is reachable, otherwise the sentence saying why not.
export type ConnectionRequest = { type: "connection" };
