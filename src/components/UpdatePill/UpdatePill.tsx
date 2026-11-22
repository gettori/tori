import { Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { createFetchState } from "../../lib/fetchState";
import Button from "../Button/Button";
import Popover from "../Popover/Popover";
import { pushToast } from "../Toasts/Toasts";
import { CHECK_UPDATES, TOAST, emitWith, on, type ToastEvent } from "../../utils/events";
import styles from "./UpdatePill.module.css";

type UpdateInfo = { version: string; blocked: string | null };
type ManualCheck = ({ state: "newer" } & UpdateInfo) | { state: "current" } | { state: "failed" };
type Stage = { kind: "found" } | { kind: "installing"; percent: number | null } | { kind: "ready" };

const RECHECK_MS = 60 * 60 * 1000;

export default function UpdatePill(props: { suppressed?: boolean }) {
  const [dismissed, setDismissed] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [stage, setStage] = createSignal<Stage>({ kind: "found" });
  const [update, { mutate }] = createFetchState(() => invoke<UpdateInfo | null>("check_for_update").catch(() => null));
  const current = createMemo<string | null | undefined>(() => getVersion().catch(() => null), {
    loadingValue: undefined,
  });
  let anchor: HTMLButtonElement | undefined;
  let primary: HTMLButtonElement | undefined;
  let cancelling = false;

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
      setOpen(true);
    } else {
      const message = found.state === "current" ? "Tori is up to date." : "Couldn't reach GitHub to check for updates.";
      emitWith<ToastEvent>(TOAST, { message, kind: found.state === "current" ? "info" : "error" });
    }
  };
  onCleanup(on(CHECK_UPDATES, () => void checkNow()));

  const install = async () => {
    cancelling = false;
    setStage({ kind: "installing", percent: null });
    try {
      const version = await invoke<string>("install_update");
      mutate({ version, blocked: null });
      setStage({ kind: "ready" });
    } catch (e) {
      setStage({ kind: "found" });
      if (!cancelling) pushToast(`Tori ${update()?.version ?? ""} did not install: ${String(e)}`);
    }
  };

  const cancel = () => {
    cancelling = true;
    void invoke("cancel_update").catch(() => {});
  };

  const releases = () => void invoke("open_releases_page").catch(() => {});
  const restart = () => void invoke("relaunch").catch((e) => pushToast(`Tori did not restart: ${String(e)}`));

  const percent = () => {
    const s = stage();
    return s.kind === "installing" ? s.percent : null;
  };
  // Past the download, extracting, verifying and the swap cannot be stopped.
  const downloading = () => stage().kind === "installing" && (percent() ?? 0) < 100;

  const label = () => {
    const s = stage();
    if (s.kind === "ready") return "Restart to update";
    if (s.kind === "installing") return s.percent === null ? "Updating" : `Updating ${s.percent}%`;
    return `Update available ${update()!.version}`;
  };

  // Suppressed rather than unmounted while onboarding is open: a first-run user
  // meeting Tori for the first time should not be handed a version notice about
  // the app they have not used yet. It reappears once they close Settings.
  const visible = () => !props.suppressed && !dismissed() && !!update();

  return (
    <Show when={visible()}>
      <button
        ref={anchor}
        type="button"
        class={styles.update}
        aria-label={`${label()}. Show update details`}
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
      >
        {label()}
      </button>
      <Show when={open()}>
        <Popover
          anchorEl={anchor}
          placement="bottom-end"
          onClose={() => setOpen(false)}
          initialFocus={() => primary}
          aria-label="Tori update"
        >
          <div class={styles.card}>
            <Switch>
              <Match when={stage().kind === "found"}>
                <div class={styles.title}>Tori {update()!.version} is available</div>
                <Show when={current()}>
                  <div class={styles.note}>You have {current()}.</div>
                </Show>
                <Show when={update()!.blocked}>
                  <div class={styles.note}>{update()!.blocked}</div>
                </Show>
                <div class={styles.actions}>
                  <Button size="sm" variant="ghost" onClick={releases}>
                    What's new
                  </Button>
                  <span class={styles.spacer} />
                  <Button
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      setDismissed(true);
                    }}
                  >
                    Later
                  </Button>
                  <Show when={!update()!.blocked}>
                    <Button ref={primary} size="sm" variant="primary" onClick={() => void install()}>
                      Install
                    </Button>
                  </Show>
                </div>
              </Match>
              <Match when={stage().kind === "installing"}>
                <div class={styles.title}>
                  {downloading() ? `Downloading Tori ${update()!.version}` : `Installing Tori ${update()!.version}`}
                </div>
                <div
                  class={styles.track}
                  role="progressbar"
                  aria-label="Update progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent() ?? undefined}
                >
                  <div class={styles.fill} style={{ width: `${percent() ?? 0}%` }} />
                </div>
                <div class={styles.actions}>
                  <span class={styles.note}>{percent() === null ? "Starting" : `${percent()}%`}</span>
                  <span class={styles.spacer} />
                  <Show when={downloading()}>
                    <Button ref={primary} size="sm" onClick={cancel}>
                      Cancel
                    </Button>
                  </Show>
                </div>
              </Match>
              <Match when={stage().kind === "ready"}>
                <div class={styles.title}>Tori {update()!.version} is installed</div>
                <div class={styles.note}>
                  Restart to start using it. The daemon restarts once no session is working.
                </div>
                <div class={styles.actions}>
                  <Button size="sm" variant="ghost" onClick={releases}>
                    What's new
                  </Button>
                  <span class={styles.spacer} />
                  <Button ref={primary} size="sm" variant="primary" onClick={restart}>
                    Restart
                  </Button>
                </div>
              </Match>
            </Switch>
          </div>
        </Popover>
      </Show>
    </Show>
  );
}
