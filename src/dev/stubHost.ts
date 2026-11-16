import { mockIPC } from "@tauri-apps/api/mocks";

/** One fixture's answers to the host: a value for a command it owns, and
 *  `undefined` for one it does not. */
export type HostHandler = (cmd: string, args: Record<string, unknown>) => unknown;

/** `mockIPC` replaces the whole host, so two fixtures each stubbing it would
 *  silently unplug the first. A page hands every fixture's handler in here
 *  instead, and the first one that answers wins. */
export function stubHost(handlers: HostHandler[]): void {
  mockIPC((cmd, args) => {
    const q = (args ?? {}) as Record<string, unknown>;
    for (const handle of handlers) {
      const answer = handle(cmd, q);
      if (answer !== undefined) return answer;
    }
    return null;
  });
}
