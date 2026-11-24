import { createDeferred, createMemo, createSignal, Errored, isPending, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConnectionRequest } from "../pick";
import { pickShortcut } from "../shortcut";
import { MIN_TORI, NOT_SET_UP, sentenceOf } from "../tab";

const SHORTCUTS_PAGE = "chrome://extensions/shortcuts";

export function Icon(props: { children: JSX.Element }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function Row(props: {
  id: string;
  icon: JSX.Element;
  label: string;
  hint: JSX.Element;
  children?: JSX.Element;
}) {
  return (
    <div class="row">
      <span class="icon">{props.icon}</span>
      <span class="text">
        <span id={props.id} class="label">
          {props.label}
        </span>
        <span class="hint">{props.hint}</span>
      </span>
      <span class="control">{props.children}</span>
    </div>
  );
}

async function connection(): Promise<string | null> {
  const request: ConnectionRequest = { type: "connection" };
  return chrome.runtime.sendMessage(request);
}

export function ShortcutRow() {
  const shortcut = createMemo(pickShortcut);
  return (
    <Row
      id="shortcut"
      label="Shortcut"
      hint="Starts and stops picking on a worktree tab."
      icon={
        <Icon>
          <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
          <path d="M4.5 7h0M7 7h0M9.5 7h0M12 7h0M5 9.5h6" />
        </Icon>
      }
    >
      <Errored fallback={(err) => <span class="unset">Unknown, {String(err())}</span>}>
        <Loading fallback={<span class="unset">Checking</span>}>
          <Show when={shortcut()} fallback={<span class="unset">Not set</span>}>
            {(keys) => <kbd>{keys().label}</kbd>}
          </Show>
        </Loading>
      </Errored>
      <button type="button" class="secondary" onClick={() => void chrome.tabs.create({ url: SHORTCUTS_PAGE })}>
        Change
      </button>
    </Row>
  );
}

export function ConnectionRow() {
  // Asked, not refreshed: a refresh is a silent re-ask, and Check again has to
  // hold its button while Tori answers.
  const [asked, setAsked] = createSignal(0);
  const reach = createDeferred(() => {
    asked();
    return connection();
  });
  const row = (ok: boolean, text: JSX.Element, button: JSX.Element) => (
    <Row
      id="connection"
      label="Connection"
      hint={
        <span class="reach">
          <span class={{ dot: true, ok }} aria-hidden="true" />
          <span role="status">{text}</span>
        </span>
      }
      icon={
        <Icon>
          <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />
        </Icon>
      }
    >
      {button}
    </Row>
  );
  const checkAgain = (props: { disabled?: boolean; onClick?: () => void }) => (
    <button type="button" class="secondary" disabled={props.disabled} onClick={() => props.onClick?.()}>
      Check again
    </button>
  );
  return (
    <Errored fallback={(err, reset) => row(false, String(err()), checkAgain({ onClick: reset }))}>
      <Loading fallback={row(false, "Asking Tori.", checkAgain({ disabled: true }))}>
        {row(
          reach() === null,
          reach() === null
            ? "Tori is running and set up for this browser."
            : reach() === sentenceOf(NOT_SET_UP)
              ? `${reach()} Install it in Tori ${MIN_TORI} or later, in Settings > Browser.`
              : reach(),
          checkAgain({
            get disabled() {
              return isPending(() => reach());
            },
            onClick: () => setAsked((n) => n + 1),
          }),
        )}
      </Loading>
    </Errored>
  );
}
