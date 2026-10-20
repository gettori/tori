import { createSignal, onMount } from "solid-js";
import { GROUPS_KEY, LOG_KEY, SHOTS_KEY } from "../tab";
import { ConnectionRow, Icon, Row, ShortcutRow } from "./rows";

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

export default function Options() {
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
          id="page-log"
          label="Console and network"
          hint="Counts the page's errors on the toolbar icon and sends its console errors and warnings and its failed requests with each send. Request and response bodies only from the DevTools panel, when you open them. Never headers. Takes effect when a tab loads."
          icon={
            <Icon>
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5" />
            </Icon>
          }
        >
          <Switch key={LOG_KEY} labelledBy="page-log" />
        </Row>
        <ShortcutRow />
        <ConnectionRow />
      </section>
    </main>
  );
}
