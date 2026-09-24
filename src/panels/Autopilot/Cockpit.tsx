import { Show, createEffect, createMemo, on, onCleanup } from "solid-js";
import AutopilotPopup from "../../components/Autopilot/AutopilotPopup";
import AutopilotSwitch from "../../components/Autopilot/AutopilotSwitch";
import AutopilotView from "../../components/Autopilot/AutopilotView";
import { Composer } from "../../components/Autopilot/ShellParts";
import type { AutopilotState } from "../../components/Autopilot/autopilot";
import ChatView from "../Chat/ChatView";
import { inFlightRows, queuedItems, workerCards } from "../../utils/autopilotRows";
import {
  activity,
  attachable,
  autopilotNow,
  decide,
  decisionCards,
  decisions,
  items,
  loadThread,
  popupOpen,
  runner,
  sendToAutopilot,
  setPopupOpen,
  setView,
  startAutopilot,
  stopAutopilot,
  thread,
  view,
  watchAutopilot,
  type RunnerStatus,
} from "../../utils/autopilotStore";
import styles from "./Cockpit.module.css";

// One tab id for every view of the autopilot: a detach names the tab it was
// attached from, and a remount on a new session is still this view.
const TAB = "autopilot-cockpit";

const STATE_LINE: Record<AutopilotState, string> = {
  off: "Off",
  idle: "Idle",
  working: "Working",
  needs: "Needs you",
  error: "Stopped",
};

const noFork = () => "";

// After a crash the dead session is shown to read, and a send there starts a fresh one.
function CockpitChat(props: { status: RunnerStatus; reading: boolean }) {
  return (
    <Show when={props.status.session} keyed>
      {(session) => (
        <ChatView
          sessionId={session}
          tabId={TAB}
          agentId={props.status.agent ?? "claude"}
          profile={null}
          cwd={props.status.cwd ?? ""}
          workspace={props.status.cwd ?? ""}
          title="Autopilot"
          resume={false}
          started={!props.reading}
          onStart={() => void startAutopilot()}
          background
          detach
          active
          onForkSession={noFork}
          onForkFrom={noFork}
          onRewindFrom={() => {}}
          onFirstSendFailed={() => {}}
          onProfileResolved={() => {}}
        />
      )}
    </Show>
  );
}

export function CockpitSwitch() {
  watchAutopilot();
  return (
    <AutopilotSwitch
      view={view()}
      state={autopilotNow()}
      count={decisions().length}
      popupOpen={popupOpen()}
      onSelectView={(v) => {
        setPopupOpen(false);
        setView(v);
      }}
      onTogglePopup={() => setPopupOpen(!popupOpen())}
      onToggleOn={() => void (autopilotNow() === "off" ? startAutopilot() : stopAutopilot())}
    />
  );
}

export function CockpitView() {
  const error = () => runner().state === "error";
  // A memo, so an idle/working flip does not remount the chat: the old view's
  // detach names the same tab and would cut off the new one's listener.
  const live = createMemo(() => attachable(runner()) || (error() && runner().session !== null));
  return (
    <div class={styles.overlay}>
      <AutopilotView
        state={autopilotNow()}
        workers={workerCards(items())}
        emptyWorkers="Nothing in flight."
        queue={queuedItems(items())}
        messages={[]}
        decisions={[]}
        activity={activity()}
        shield="Nothing leaves this machine until you approve it."
        error={runner().error ?? undefined}
        chat={live() ? <CockpitChat status={runner()} reading={error()} /> : undefined}
        onStart={() => void startAutopilot()}
        onRestart={() => void startAutopilot()}
      />
    </div>
  );
}

export function CockpitPopup() {
  let anchor!: HTMLDivElement;
  createEffect(on(() => [popupOpen(), runner().state, runner().session] as const, ([open]) => open && void loadThread()));
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPopupOpen(false);
  // The switch toggles it itself, so a press there is not an outside click.
  const onPointer = (e: PointerEvent) => {
    const target = e.target as Node;
    if (!anchor.contains(target) && !(target instanceof Element && target.closest("[aria-label='Autopilot']"))) setPopupOpen(false);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", onPointer);
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onPointer);
  });
  return (
    <div class={styles.popupAnchor} ref={anchor}>
      <AutopilotPopup
        state={autopilotNow()}
        stateLine={STATE_LINE[autopilotNow()]}
        decisions={decisionCards()}
        inFlight={inFlightRows(items())}
        messages={thread()}
        error={runner().error ?? undefined}
        onDecision={decide}
        composer={
          <Composer
            dense
            disabled={!attachable(runner())}
            placeholder={autopilotNow() === "off" ? "Start the autopilot to message it" : "Tell the autopilot..."}
            onSend={(text) => void sendToAutopilot(text).then(loadThread)}
          />
        }
        onOpenView={() => {
          setPopupOpen(false);
          setView("autopilot");
        }}
        onStart={() => void startAutopilot()}
        onRestart={() => void startAutopilot()}
        onViewLog={() => {
          setPopupOpen(false);
          setView("autopilot");
        }}
        onTurnOff={() => void stopAutopilot()}
      />
    </div>
  );
}
