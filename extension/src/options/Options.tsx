import { createResource, createSignal, onMount, Show, type JSX } from "solid-js";
import type { ConnectionRequest } from "../pick";
import { pickShortcut } from "../shortcut";
import { GROUPS_KEY, NOT_SET_UP, SHOTS_KEY, sentenceOf } from "../tab";

const SHORTCUTS_PAGE = "chrome://extensions/shortcuts";

function Icon(props: { children: JSX.Element }) {
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

function Row(props: { id: string; icon: JSX.Element; label: string; hint: JSX.Element; children: JSX.Element }) {
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

function Switch(props: { key: string; labelledBy: string }) {
  const [on, setOn] = createSignal(true);
  onMount(() => {
    void chrome.storage.local.get(props.key).then((stored) => setOn(stored[props.key] !== false));
  });
  const toggle = () => {
    const next = !on();
    setOn(next);
    void chrome.storage.local.set({ [props.key]: next });
  };
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={on()}
      aria-labelledby={props.labelledBy}
      onClick={toggle}
    >
      <span class="knob" />
    </button>
  );
}

async function connection(): Promise<string | null> {
  const request: ConnectionRequest = { type: "connection" };
  return chrome.runtime.sendMessage(request);
}

export default function Options() {
  const [shortcut] = createResource(pickShortcut);
  const [reach, { refetch }] = createResource(connection);

  return (
    <main>
      <header>
        <h1>Tori</h1>
        <p>Browser extension</p>
      </header>
      <section class="card" aria-label="Options">
        <Row
          id="groups"
          label="Group tabs by branch"
          hint="Puts each worktree's tabs in a tab group named after its branch."
          icon={
            <Icon>
              <circle cx="5" cy="3.5" r="1.5" />
              <circle cx="5" cy="12.5" r="1.5" />
              <circle cx="11" cy="5.5" r="1.5" />
              <path d="M5 5v6M11 7c0 2.5-6 2-6 4" />
            </Icon>
          }
        >
          <Switch key={GROUPS_KEY} labelledBy="groups" />
        </Row>
        <Row
          id="screenshots"
          label="Screenshots"
          hint="Attaches a viewport and an element screenshot to each pick. Off sends text only."
          icon={
            <Icon>
              <rect x="2" y="4.5" width="12" height="9" rx="1.5" />
              <path d="M6 4.5l1-2h2l1 2" />
              <circle cx="8" cy="9" r="2.25" />
            </Icon>
          }
        >
          <Switch key={SHOTS_KEY} labelledBy="screenshots" />
        </Row>
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
                      ? `${reach()} Install it in Tori > Settings > Browser.`
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
      </section>
    </main>
  );
}
