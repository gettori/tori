import { componentsOf, fiberOf } from "./fiber";
import type { InspectChannel, InspectMessage } from "./pick";

const CHANNEL: InspectChannel = "tori:inspect";

// Injected again on every pick request; the first copy in this world answers.
const loaded = globalThis as { toriInspect?: boolean };

function answer(target: EventTarget | null, sensitive: boolean): InspectMessage {
  const fiber = target instanceof Node ? fiberOf(target) : null;
  const found = fiber && componentsOf(fiber, sensitive);
  return { type: "found", chain: found?.chain ?? [], props: found?.props ?? null, source: null };
}

if (!loaded.toriInspect) {
  loaded.toriInspect = true;
  document.addEventListener(
    CHANNEL,
    (e) => {
      if (!(e instanceof CustomEvent) || typeof e.detail !== "string") return;
      let message: InspectMessage;
      try {
        message = JSON.parse(e.detail) as InspectMessage;
      } catch {
        // Page code can dispatch anything under this event name.
        return;
      }
      if (message.type !== "ask") return;
      let reply: InspectMessage;
      // The page's own code must never see this script fail.
      try {
        reply = answer(e.target, message.sensitive);
      } catch {
        return;
      }
      document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(reply) }));
    },
    true,
  );
}
