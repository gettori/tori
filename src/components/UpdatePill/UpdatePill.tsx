import { Match, Show, Switch, createSignal, createResource, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-solid";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import { pushToast } from "../Toasts/Toasts";
import { CHECK_UPDATES, TOAST, emitWith, on, type ToastEvent } from "../../utils/events";
import styles from "./UpdatePill.module.css";

type UpdateInfo = { version: string; blocked: string | null };
type ManualCheck = ({ state: "newer" } & UpdateInfo) | { state: "current" } | { state: "failed" };
type Stage = { kind: "found" } | { kind: "installing"; percent: number } | { kind: "ready" };

const RECHECK_MS = 60 * 60 * 1000;

export default function UpdatePill(props: { suppressed?: boolean }) {
  const [dismissed, setDismissed] = createSignal(false);
  const [stage, setStage] = createSignal<Stage>({ kind: "found" });
  const [update, { mutate }] = createResource(() => invoke<UpdateInfo | null>("check_for_update").catch(() => null));

  // A window stays open for days, so a release must not wait for a relaunch.
  const recheck = setInterval(() => {
    if (stage().kind !== "found") return;
    void invoke<UpdateInfo | null>("check_for_update")
      .then((found) => found && mutate(found))
      .catch((e) => console.error("check_for_update:", e));
  }, RECHECK_MS);
  onCleanup(() => clearInterval(recheck));

  const offProgress = listen<{ received: number; total: number }>("update://progress", ({ payload }) => {
    if (stage().kind === "installing" && payload.total > 0)
      setStage({ kind: "installing", percent: Math.floor((payload.received * 100) / payload.total) });
  });
  onCleanup(() => void offProgress.then((f) => f()));

  // Asked for, so it answers even when there is nothing newer.
  const checkNow = async () => {
    const found = await invoke<ManualCheck>("check_for_update_now").catch((): ManualCheck => ({ state: "failed" }));
    if (found.state === "newer") {
      mutate({ version: found.version, blocked: found.blocked });
      setDismissed(false);
    } else {
      const message = found.state === "current" ? "Tori is up to date." : "Couldn't reach GitHub to check for updates.";
      emitWith<ToastEvent>(TOAST, { message, kind: found.state === "current" ? "info" : "error" });
    }
  };
  onCleanup(on(CHECK_UPDATES, () => void checkNow()));

  const install = async () => {
    setStage({ kind: "installing", percent: 0 });
    try {
      await invoke("install_update");
      setStage({ kind: "ready" });
    } catch (e) {
      setStage({ kind: "found" });
      pushToast(`Tori ${update()?.version ?? ""} did not install: ${String(e)}`);
    }
  };

  // Suppressed rather than unmounted while onboarding is open: a first-run user
  // meeting Tori for the first time should not be handed a version notice about
  // the app they have not used yet. It reappears once they close Settings.
  const visible = () => !props.suppressed && !dismissed() && !!update();

  return (
    <Show when={visible()}>
      <div class={styles.pill}>
        <Switch>
          <Match when={stage().kind === "found"}>
            <Tooltip
              as="button"
              type="button"
              class={styles.link}
              label={`Tori ${update()!.version} is available - opens the release page`}
              onClick={() => invoke("open_releases_page").catch(() => {})}
            >
              Update available
            </Tooltip>
            <Show
              when={!update()!.blocked}
              fallback={
                <Tooltip as="span" class={styles.link} label={update()!.blocked!}>
                  Can't install here
                </Tooltip>
              }
            >
              <Tooltip
                as="button"
                type="button"
                class={styles.link}
                aria-label="Install the update"
                label={`Download Tori ${update()!.version} and put it in place of this one`}
                onClick={() => void install()}
              >
                Install
              </Tooltip>
            </Show>
          </Match>
          <Match when={stage().kind === "installing"}>
            <span class={styles.link} role="status">
              {`Updating ${(stage() as { percent: number }).percent}%`}
            </span>
          </Match>
          <Match when={stage().kind === "ready"}>
            <Tooltip
              as="button"
              type="button"
              class={styles.link}
              label={`Tori ${update()!.version} is installed. The daemon restarts once no session is working.`}
              onClick={() => invoke("relaunch").catch((e) => pushToast(`Tori did not restart: ${String(e)}`))}
            >
              Restart to update
            </Tooltip>
          </Match>
        </Switch>
        <Show when={stage().kind !== "installing"}>
          <Tooltip
            as="button"
            type="button"
            class={styles.dismiss}
            aria-label="Dismiss update notice"
            label="Dismiss"
            onClick={() => setDismissed(true)}
          >
            <Icon icon={X} />
          </Tooltip>
        </Show>
      </div>
    </Show>
  );
}
