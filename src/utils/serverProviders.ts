// Which providers the server answering the active file advertises, so the
// palette can hide a command that server cannot answer. Eager and
// CodeMirror-free for the reason `sourceActions.ts` is: the editor publishes,
// the omnibox reads.
import { createSignal } from "solid-js";

const [providers, setProviders] = createSignal<readonly string[]>([]);

export function publishServerProviders(next: readonly string[]): void {
  const now = providers();
  if (now.length === next.length && now.every((p, i) => p === next[i])) return;
  setProviders([...next]);
}

export function activeServerProvides(capability: string): boolean {
  return providers().includes(capability);
}
