// Tabs whose shell gave the terminal to something else before their init was
// typed, keyed by tab id, with what took it. A signal beside the tab model for
// `commandStatus`'s reason: the strip keys tabs by identity.
import { createSignal } from "solid-js";

const [refused, setRefused] = createSignal<Record<string, string>>({});

/** What took the terminal from this tab's shell, or null when nothing did. */
export const initRefusal = (id: string): string | null => refused()[id] ?? null;

/** Record a `pty://init-refused`. */
export function refuseInit(id: string, foreground: string): void {
  setRefused((all) => ({ ...all, [id]: foreground }));
}

/** A closed tab leaves nothing behind, or a later tab reusing the id would
 *  inherit a refusal it never had. */
export function dropInitRefusal(id: string): void {
  setRefused((all) => {
    if (!(id in all)) return all;
    const next = { ...all };
    delete next[id];
    return next;
  });
}
