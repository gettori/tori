import { createResource, createSignal, onMount, Show } from "solid-js";
import type { PickRequest } from "../pick";
import { GROUPS_KEY, label, type StateRequest, type TabState } from "../tab";

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function activeState(): Promise<TabState | null> {
  const tabId = await activeTabId();
  if (tabId === undefined) return null;
  const request: StateRequest = { type: "state", tabId };
  return chrome.runtime.sendMessage(request);
}

async function pick() {
  const tabId = await activeTabId();
  if (tabId === undefined) return;
  const request: PickRequest = { type: "pick", tabId };
  await chrome.runtime.sendMessage(request);
  window.close();
}

export default function Popup() {
  const [state] = createResource(activeState);
  const [groups, setGroups] = createSignal(true);

  onMount(() => {
    void chrome.storage.local.get(GROUPS_KEY).then((stored) => setGroups(stored[GROUPS_KEY] !== false));
  });

  const toggle = (on: boolean) => {
    setGroups(on);
    void chrome.storage.local.set({ [GROUPS_KEY]: on });
  };

  return (
    <main>
      <Show when={state()} fallback={<p class="muted">{state.loading ? "Asking Tori" : "No tab"}</p>}>
        {(s) => (
          <Show
            when={s().kind === "worktree" && s()}
            fallback={<p class="muted">{(s() as { title: string }).title}</p>}
          >
            {(w) => {
              const tab = w() as Extract<TabState, { kind: "worktree" }>;
              return (
                <>
                  <p class="branch">{label(tab.unit)}</p>
                  <p class="muted">{tab.unit.name}</p>
                  <button type="button" onClick={() => void pick()}>
                    Pick and comment
                  </button>
                </>
              );
            }}
          </Show>
        )}
      </Show>
      <label class="switch">
        <input type="checkbox" checked={groups()} onChange={(e) => toggle(e.currentTarget.checked)} />
        Group tabs by branch
      </label>
      <p class="muted">Tori &gt; Settings &gt; Browser</p>
    </main>
  );
}
