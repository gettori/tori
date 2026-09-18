import { createSignal, onCleanup, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../../../../utils/clipboard";
import { isForgeError, type DevicePrompt } from "../../../../utils/forgeTypes";
import type { Failure } from "./forgeAddFlow";

type PollReport =
  | { kind: "authorized"; accountId: string; login: string }
  | { kind: "pending"; nextIntervalSecs: number }
  | { kind: "denied"; code: string }
  | { kind: "expired"; code: string };

// Through the opener plugin, as `Markdown` does: in the app's webview
// `window.open` does not reach the default browser.
export function openInBrowser(url: string) {
  void invoke("plugin:opener|open_url", { url }).catch(() => {});
}

export function asFailure(e: unknown): Failure {
  return isForgeError(e)
    ? { kind: "error", message: e.message, code: e.kind }
    : { kind: "error", message: String(e), code: null };
}

export function failureText(host: string, failure: Failure, lifetimeSecs: number | null): JSX.Element {
  const minutes = Math.round((lifetimeSecs ?? 0) / 60);
  switch (failure.kind) {
    case "denied":
      return (
        <>
          {host} says the sign-in was denied: <code>{failure.code}</code>. Nothing was stored, and starting
          again issues a fresh code.
        </>
      );
    case "expired":
      return (
        <>
          {host} expired the code before it was entered: <code>{failure.code}</code>.
          {minutes > 0 ? ` Codes last about ${minutes} minute${minutes === 1 ? "" : "s"}.` : ""} Starting again
          issues a fresh one.
        </>
      );
    case "error":
      return (
        <>
          {failure.message}
          {failure.code === null ? "" : <> <code>{failure.code}</code></>}
        </>
      );
    case "needsToken":
      return (
        <>
          {failure.host} needs a personal access token, and Tori asks for one in Settings {">"} Hosts. Install
          the GitHub CLI and sign in with it to skip that.
        </>
      );
  }
}

/**
 * One browser sign-in at a time, as Rust holds it: adopt the flow Rust started,
 * poll at the pace the host asks for, and settle into `onAuthorized` or
 * `onFailed`. Shared by Settings > Hosts and first run's hosts step.
 */
export function createDeviceFlow(handlers: {
  onAuthorized: (signedIn: { accountId: string; login: string }) => void;
  onFailed: (failure: Failure) => void;
}) {
  const [prompt, setPrompt] = createSignal<DevicePrompt | null>(null);
  const [lifetimeSecs, setLifetimeSecs] = createSignal<number | null>(null);
  const [deadline, setDeadline] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [clipboardOk, setClipboardOk] = createSignal(true);

  // Every start and cancel takes a new run, and an answer for an older one is
  // dropped, so a flow the user walked away from cannot land late.
  let run = 0;

  // The poll timer must not outlive the owner: a flow left running keeps
  // hitting the host after the panel closed, and on a `slow_down` that is how a
  // throttle becomes a block.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const stopTimers = () => {
    clearTimeout(timer);
    clearInterval(ticker);
    timer = undefined;
    ticker = undefined;
  };

  function cancel() {
    run += 1;
    stopTimers();
    if (!prompt()) return;
    setPrompt(null);
    void invoke("forge_device_cancel");
  }
  onCleanup(cancel);

  // Rust has already started this flow, so there is no cancel here: cancelling
  // would drop the very pending sign-in being adopted. The caller cancels any
  // previous one *before* it asks Rust to start another.
  async function resume(p: DevicePrompt) {
    const mine = run;
    setPrompt(p);
    setLifetimeSecs(p.expiresInSecs);
    setDeadline(Date.now() + p.expiresInSecs * 1000);
    setNow(Date.now());
    // On the clipboard before the page opens, so the paste is ready when it loads.
    setClipboardOk(await copyText(p.userCode));
    if (run !== mine || prompt() !== p) return;
    openInBrowser(p.verificationUri);
    schedule(mine, p.intervalSecs);
    ticker = setInterval(() => tick(mine), 1000);
  }

  // At zero the host is asked rather than told: its own `expired_token` is what
  // the error card quotes, and a clock that runs ahead of the host's is not.
  function tick(mine: number) {
    setNow(Date.now());
    if (Date.now() < deadline()) return;
    stopTimers();
    void pollOnce(mine);
  }

  // The interval comes from the server on every turn, so a `slow_down` actually
  // slows this caller down instead of being noted and ignored.
  function schedule(mine: number, seconds: number) {
    clearTimeout(timer);
    timer = setTimeout(() => void pollOnce(mine), seconds * 1000);
  }

  async function pollOnce(mine: number) {
    if (run !== mine) return;
    let report: PollReport;
    try {
      report = await invoke<PollReport>("forge_device_poll");
    } catch (e) {
      if (run !== mine) return;
      cancel();
      handlers.onFailed(asFailure(e));
      return;
    }
    if (run !== mine) return;
    switch (report.kind) {
      case "pending":
        schedule(mine, report.nextIntervalSecs);
        return;
      // Rust has already dropped the flow on all three, so there is nothing to
      // cancel there.
      case "authorized":
        settle();
        handlers.onAuthorized({ accountId: report.accountId, login: report.login });
        return;
      case "denied":
      case "expired":
        settle();
        handlers.onFailed({ kind: report.kind, code: report.code });
        return;
    }
  }

  function settle() {
    run += 1;
    stopTimers();
    setPrompt(null);
  }

  async function copyAgain() {
    const p = prompt();
    if (p) setClipboardOk(await copyText(p.userCode));
  }

  return {
    prompt,
    lifetimeSecs,
    remainingMs: () => deadline() - now(),
    clipboardOk,
    resume,
    cancel,
    copyAgain,
  };
}
