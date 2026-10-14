import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Tooltip from "../Tooltip/Tooltip";
import { pushToast } from "../Toasts/Toasts";
import type { DaemonStatus } from "../../utils/daemonStatus";
import styles from "../UpdatePill/UpdatePill.module.css";

// The update's count belongs to the daemon the link is on, so it is held with
// that link's status and goes with it.
type Seen = { status: DaemonStatus | null; sessions: number | null };

export default function DaemonPill() {
  const [seen, setSeen] = createSignal<Seen>({ status: null, sessions: null });

  onMount(() => {
    void invoke<DaemonStatus | null>("daemon_status")
      .then((status) => setSeen({ status, sessions: null }))
      .catch((e) => console.error("daemon_status:", e));
    const offStatus = listen<DaemonStatus>("daemon://status", ({ payload }) =>
      setSeen({ status: payload, sessions: null }),
    );
    const offWaiting = listen<{ sessions: number }>("daemon://update-waiting", ({ payload }) =>
      setSeen({ ...seen(), sessions: payload.sessions }),
    );
    onCleanup(() => {
      void offStatus.then((f) => f());
      void offWaiting.then((f) => f());
    });
  });

  const restart = () =>
    invoke("daemon_restart_now").catch((e) => pushToast(`Tori's daemon did not start: ${String(e)}`));

  const text = () => {
    const { status, sessions } = seen();
    if (status?.state === "gaveUp") return `Daemon stopped after ${status.message} failed starts`;
    if (status?.state === "restartNeeded") return "Restart needed for the update";
    if (status?.state === "off") return "Daemon uninstalled";
    if (sessions) return `Update waiting for ${sessions} ${sessions === 1 ? "session" : "sessions"}`;
    return null;
  };
  const why = () => {
    const { status } = seen();
    if (status?.state === "gaveUp")
      return "It failed to start several times in a row, so it stopped trying. See daemon.log.";
    if (status?.state === "restartNeeded") return status.message;
    if (status?.state === "off") return "tori daemon --uninstall stopped it. Starting it installs it again.";
    return "The update applies once no session is working. Restarting now stops the turns in flight.";
  };
  const action = () => {
    const state = seen().status?.state;
    if (state === "gaveUp") return "Try again";
    if (state === "off") return "Start";
    return "Restart now";
  };

  return (
    <Show when={text()}>
      <div class={styles.pill}>
        <Tooltip as="span" class={styles.link} label={why()}>
          {text()}
        </Tooltip>
        <Tooltip as="button" type="button" class={styles.link} label="Start Tori's daemon again" onClick={restart}>
          {action()}
        </Tooltip>
      </div>
    </Show>
  );
}
