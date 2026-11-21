import type { JSX } from "solid-js";

export type TriggerHandler = JSX.EventHandlerUnion<HTMLElement, any> | undefined;

export function callHandler(e: Event, handler: TriggerHandler) {
  if (typeof handler === "function") (handler as (event: Event) => void)(e);
  else if (handler) (handler[0] as (data: unknown, event: Event) => void)(handler[1], e);
}
