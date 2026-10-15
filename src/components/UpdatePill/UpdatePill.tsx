import { Show, createSignal, createResource, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { X } from "lucide-solid";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import { CHECK_UPDATES, OPEN_JOB, TOAST, emitWith, on, type OpenJob, type ToastEvent } from "../../utils/events";
import styles from "./UpdatePill.module.css";

// A dismissible "new version" notice in the topbar. Deliberately the smallest
// thing that does the job: Tori ships unsigned, so it can never install an
// update for you (replacing the bundle re-triggers quarantine anyway). All it
// can honestly offer is "there is a newer one, here is where it lives", plus,
// when Homebrew owns the install, brew's own upgrade in a tab you can watch.
//
// The backend owns every decision about *whether* there is an update - the
// daily throttle, the semver comparison, and staying silent when offline - so
// a null answer here means exactly one thing: render nothing.

type UpdateInfo = { version: string; brew: boolean };
type ManualCheck = ({ state: "newer" } & UpdateInfo) | { state: "current" } | { state: "failed" };

async function brewUpgrade() {
  const cwd = await homeDir().catch(() => "/");
  emitWith<OpenJob>(OPEN_JOB, {
    id: "update:tori",
    title: "Update Tori",
    cwd,
    program: "brew",
    args: ["upgrade", "--cask", "tori"],
    // brew does not prompt for this, but a cask can ask for a sudo password.
    interactive: true,
    relaunchOnSuccess: true,
  });
}

export default function UpdatePill(props: { suppressed?: boolean }) {
  const [dismissed, setDismissed] = createSignal(false);
  const [update, { mutate }] = createResource(() => invoke<UpdateInfo | null>("check_for_update").catch(() => null));

  // Asked for, so it answers even when there is nothing newer.
  const checkNow = async () => {
    const found = await invoke<ManualCheck>("check_for_update_now").catch((): ManualCheck => ({ state: "failed" }));
    if (found.state === "newer") {
      mutate({ version: found.version, brew: found.brew });
      setDismissed(false);
    } else {
      const message = found.state === "current" ? "Tori is up to date." : "Couldn't reach GitHub to check for updates.";
      emitWith<ToastEvent>(TOAST, { message, kind: found.state === "current" ? "info" : "error" });
    }
  };
  onCleanup(on(CHECK_UPDATES, () => void checkNow()));

  // Suppressed rather than unmounted while onboarding is open: a first-run user
  // meeting Tori for the first time should not be handed a version notice about
  // the app they have not used yet. It reappears once they close Settings.
  const visible = () => !props.suppressed && !dismissed() && !!update();

  return (
    <Show when={visible()}>
      <div class={styles.pill}>
        <Tooltip
          as="button"
          type="button"
          class={styles.link}
          label={`Tori ${update()!.version} is available - opens the release page`}
          onClick={() => invoke("open_releases_page").catch(() => {})}
        >
          Update available
        </Tooltip>
        <Show when={update()!.brew}>
          <Tooltip
            as="button"
            type="button"
            class={styles.link}
            aria-label="Install with Homebrew"
            label={`Install Tori ${update()!.version} with Homebrew`}
            onClick={() => void brewUpgrade()}
          >
            Install
          </Tooltip>
        </Show>
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
      </div>
    </Show>
  );
}
