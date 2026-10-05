import { createResource, createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { FileWarning, Folder } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import Icon from "../../../../components/Icon/Icon";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { firstRunConfig, forgetIntro } from "../../../../utils/firstRun";
import { shortHome } from "../../../../utils/names";
import { ago } from "../../../../utils/relativeTime";
import type { CrashLogs } from "../../../../utils/crashReport";
import { Group, idsIn, rowDomId, type PaneProps } from "../../components/paneKit";
import styles from "../../Settings.module.css";

/** What the pending confirmation is for. `change` carries the folder already
 *  picked, so the dialog can name both ends of the swap rather than asking the
 *  user to remember what they just clicked. */
type Pending = { kind: "change"; path: string } | { kind: "forget" };

/**
 * The base folder, and the two actions that replace or forget it.
 *
 * Both used to sit in the sidebar's gear menu, one click from the strip they
 * act on: "Add/Update root" opened a folder picker that swapped the whole tree
 * the moment something was selected, and only "Reset root" asked first. They
 * are settings-shaped rather than sidebar-shaped (touched once and then never
 * again), so they live here, in a zone that says what each one costs before the
 * picker opens.
 */
export default function AdvancedPane(props: PaneProps) {
  const [home, setHome] = createSignal("/");
  onMount(
    () =>
      void homeDir()
        .then(setHome)
        .catch(() => {}),
  );

  const root = () => firstRunConfig()?.roots?.[0] ?? null;
  const spaces = () => firstRunConfig()?.spaces ?? [];
  const projects = () => spaces().reduce((n, g) => n + g.projects.length, 0);

  const [pending, setPending] = createSignal<Pending | null>(null);
  const [busy, setBusy] = createSignal(false);

  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  // Read on every pane open rather than cached: a crash file appears between
  // launches, and the pane is where the user comes to find it.
  const [crashes] = createResource(() => invoke<CrashLogs>("crash_logs").catch(() => null));
  // Guarded like every IPC reply read in a pane: a shape that is not the one
  // expected reads as "nothing answered", never as a thrown render.
  const crashFiles = () => {
    const files = crashes()?.files;
    return Array.isArray(files) ? files : [];
  };
  const crashVersion = () => {
    const v = crashes()?.version;
    return typeof v === "string" ? v : null;
  };
  const newestCrash = () => crashFiles()[0] ?? null;

  function fail(e: unknown) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }

  /** What the confirmation says, per action. Both name the folder rather than
   *  the button that led here: "are you sure" over a picker the user has
   *  already dismissed answers nothing. */
  const ask = (req: Pending) => {
    const here = root() ? shortHome(root()!, home()) : "the base folder";
    return req.kind === "change"
      ? {
          title: "Point Tori at a different folder?",
          message: `Tori will list whatever spaces it finds in ${shortHome(req.path, home())}, and stop listing the ${count(spaces().length, "space", "spaces")} in ${here}. Nothing on disk moves, and pointing it back brings them all straight back.`,
          confirmLabel: "Use this folder",
        }
      : {
          title: "Forget the base folder?",
          message: `Tori will forget ${here} and show first-run setup again. Nothing on disk is deleted: your ${count(spaces().length, "space", "spaces")} and everything inside them stay where they are.`,
          confirmLabel: "Forget",
        };
  };

  // The picker comes first and the confirmation second: "change to what" is the
  // question a confirmation here has to answer, and it cannot until a folder
  // has been named. Cancelling the picker is a no-op, never a dialog.
  async function pickFolder() {
    try {
      const path = await invoke<string | null>("pick_folder");
      if (path) setPending({ kind: "change", path });
    } catch (e) {
      fail(e);
    }
  }

  async function confirmed() {
    const req = pending();
    if (!req) return;
    setBusy(true);
    try {
      if (req.kind === "change") {
        await invoke("set_root", { path: req.path });
      } else {
        // Before the root goes: losing it opens the first-run modal, which
        // reads this flag once as it mounts.
        await forgetIntro();
        await invoke("remove_root");
      }
      setPending(null);
      // Both commands emit `config://changed`, so the sidebar and the first-run
      // store reload themselves. Closing is about what is on screen: a settings
      // panel over a workspace that has just become a different one (or over
      // the first-run modal, which is now the app) is a panel nobody asked to
      // keep reading.
      props.onClose?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Group {...props} title="Base folder" ids={idsIn("root")}>
        <div id={rowDomId("base-folder")} class={styles.connect}>
          <div class={styles.connectGlyph} aria-hidden="true">
            <Icon icon={Folder} size="calc(28px * var(--ui-scale))" />
          </div>
          <div class={styles.connectMain}>
            <div class={styles.connectTitle}>
              <Show when={root()} fallback="No base folder set">
                {(p) => <code>{shortHome(p(), home())}</code>}
              </Show>
            </div>
            <div class={styles.cardStatus}>
              <Show when={root()} fallback="Tori has nowhere to keep spaces, so it is showing first-run setup instead.">
                Holding {count(spaces().length, "space", "spaces")} and {count(projects(), "project", "projects")}.
                Every space is a folder inside this one, and every project lives inside a space. Tori reads it and
                writes new spaces into it; it never moves what is already there.
              </Show>
            </div>
          </div>
        </div>
      </Group>

      <Group {...props} title="Crash logs" ids={idsIn("crashes")}>
        <div id={rowDomId("crash-logs")} class={styles.connect}>
          <div class={styles.connectGlyph} aria-hidden="true">
            <Icon icon={FileWarning} size="calc(28px * var(--ui-scale))" />
          </div>
          <div class={styles.connectMain}>
            <div class={styles.connectTitle}>
              Tori <Show when={crashVersion()}>{(v) => v()}</Show>
            </div>
            <div class={styles.cardStatus}>
              <Show
                when={newestCrash()}
                fallback="No crash files. If Tori ever closes on its own, the next launch says so and the file lands here."
              >
                {(f) => (
                  <>
                    {count(crashFiles().length, "crash file", "crash files")}, the newest {ago(f().at)} ago:{" "}
                    <code>{f().headline}</code>. Nothing is sent anywhere until you report it.
                  </>
                )}
              </Show>
            </div>
          </div>
          <Button
            disabled={!newestCrash()}
            onClick={() => void invoke("reveal_in_finder", { path: newestCrash()!.path }).catch(fail)}
          >
            Reveal
          </Button>
          <Button onClick={() => void invoke("open_crash_issue").catch(fail)}>Report a bug</Button>
        </div>
      </Group>

      <Group {...props} title="Danger zone" ids={idsIn("danger")}>
        <Show when={props.shown("change-base-folder")}>
          <div id={rowDomId("change-base-folder")} class={styles.danger}>
            <div>
              <div class={styles.dangerTitle}>Change base folder</div>
              <div class={styles.dangerNote}>
                Tori keeps one base folder, so a new one replaces this one. Nothing on disk moves or is deleted: your
                spaces and projects stay exactly where they are, Tori just stops listing them and lists whatever it
                finds under the new folder instead. Chats and terminals already open keep running against their own
                folders, and pointing Tori back here brings the old list straight back.
              </div>
            </div>
            <Button disabled={busy()} onClick={() => void pickFolder()}>
              Choose folder…
            </Button>
          </div>
        </Show>

        <Show when={props.shown("forget-base-folder")}>
          <div id={rowDomId("forget-base-folder")} class={styles.danger}>
            <div>
              <div class={styles.dangerTitle}>Forget base folder</div>
              <div class={styles.dangerNote}>
                Tori drops its record of the folder and starts over at first-run setup, as if this machine had never
                been set up. Nothing on disk is deleted: the folder, its spaces, your projects and their worktrees all
                stay. Use it to hand Tori a clean slate, or before moving your work somewhere else.
              </div>
            </div>
            <Button disabled={busy() || !root()} onClick={() => setPending({ kind: "forget" })}>
              Forget
            </Button>
          </div>
        </Show>
      </Group>

      <Show when={pending()}>
        {(req) => (
          <ConfirmDialog
            danger={req().kind === "forget"}
            title={ask(req()).title}
            message={ask(req()).message}
            confirmLabel={ask(req()).confirmLabel}
            onConfirm={() => void confirmed()}
            onCancel={() => setPending(null)}
          />
        )}
      </Show>
    </>
  );
}
