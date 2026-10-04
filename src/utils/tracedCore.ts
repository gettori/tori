/**
 * Stands in for `@tauri-apps/api/core` in the production build, so every invoke
 * in the app can be timed. The `tori-trace-core` plugin in `vite.config.ts`
 * rewrites the import; this module is the only one it lets through to the real
 * package.
 *
 * Everything but `invoke` is re-exported untouched. `invoke` is wrapped, and
 * the wrapper is a straight pass-through until `perfTrace` hands it a recorder,
 * which only happens when the backend was launched with `TORI_TRACE`.
 */

export * from "@tauri-apps/api/core";
import { invoke as realInvoke, type InvokeOptions } from "@tauri-apps/api/core";

/** Given a call, returns the arguments to actually send (the correlation id is
 *  added there) and what to run once it answers. Returning nothing means "do
 *  not time this one", which is how the trace's own commands stay out. */
export type InvokeRecorder = (
  cmd: string,
  args: unknown,
) => { args: unknown; done: (result?: unknown) => void } | undefined;

let recorder: InvokeRecorder | null = null;

export function setInvokeRecorder(fn: InvokeRecorder | null): void {
  recorder = fn;
}

export async function invoke<T>(cmd: string, args?: unknown, options?: InvokeOptions): Promise<T> {
  const rec = recorder?.(cmd, args);
  if (!rec) return realInvoke<T>(cmd, args as never, options);
  let result: T | undefined;
  try {
    result = await realInvoke<T>(cmd, rec.args as never, options);
    return result;
  } finally {
    rec.done(result);
  }
}
