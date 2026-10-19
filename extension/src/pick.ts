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
};

export type ToggleRequest = { type: "picker.toggle" };

export type BatchRequest = { type: "batch.get" } | { type: "batch.add"; pick: Pick } | { type: "batch.clear" };

export type PickRequest = { type: "pick"; tabId: number };
