// Longer than a cold start of anything Tori runs in a worker on a slow
// machine, so only a worker that is never coming answers to it.
const READY_MS = 10_000;

/**
 * Starts a module worker that posts `{ ready: true }` once it is up, or
 * `{ failed }` when its own start throws. `fail` runs at most once: on a
 * construction error, an `error` event, a `failed` message, or no `ready` in
 * time, and the worker is terminated first. Every other message goes to
 * `onMessage`. Null when it could not even be constructed.
 *
 * `create` stays at the call site because Vite only bundles a worker it sees
 * written as `new Worker(new URL(...), ...)` there.
 */
export function startWorker(
  create: () => Worker,
  onMessage: (data: unknown) => void,
  fail: (why: unknown) => void,
): Worker | null {
  let worker: Worker | null = null;
  let down = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failOnce = (why: unknown) => {
    if (down) return;
    down = true;
    clearTimeout(timer);
    worker?.terminate();
    fail(why);
  };
  try {
    worker = create();
  } catch (e) {
    failOnce(e);
    return null;
  }
  timer = setTimeout(() => failOnce("no ready message"), READY_MS);
  worker.addEventListener("error", (e) => failOnce(e.message || "error event"));
  worker.addEventListener("message", ({ data }: MessageEvent) => {
    if (data?.ready) clearTimeout(timer);
    else if (data?.failed) failOnce(data.failed);
    else onMessage(data);
  });
  return worker;
}
