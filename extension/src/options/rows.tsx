import { createResource, Show, type JSX } from "solid-js";
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
  const [shortcut] = createResource(pickShortcut);
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
      <Show when={shortcut()} fallback={<span class="unset">Not set</span>}>
        {(keys) => <kbd>{keys().label}</kbd>}
      </Show>
      <button type="button" class="secondary" onClick={() => void chrome.tabs.create({ url: SHORTCUTS_PAGE })}>
        Change
      </button>
    </Row>
  );
}

export function ConnectionRow() {
  const [reach, { refetch }] = createResource(connection);
  return (
    <Row
      id="connection"
      label="Connection"
      hint={
        <span class="reach">
          <span classList={{ dot: true, ok: reach() === null && !reach.loading }} aria-hidden="true" />
          <span role="status">
            {reach.loading
              ? "Asking Tori."
              : reach() === null
                ? "Tori is running and set up for this browser."
                : reach() === sentenceOf(NOT_SET_UP)
                  ? `${reach()} Install it in Tori ${MIN_TORI} or later, in Settings > Browser.`
                  : reach()}
          </span>
        </span>
      }
      icon={
        <Icon>
          <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />
        </Icon>
      }
    >
      <button type="button" class="secondary" disabled={reach.loading} onClick={() => void refetch()}>
        Check again
      </button>
    </Row>
  );
}
