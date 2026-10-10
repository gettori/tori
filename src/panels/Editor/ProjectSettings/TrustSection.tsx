import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import Button from "../../../components/Button/Button";
import { emitWith, OPEN_SETTINGS, TOAST, type OpenSettings, type ToastEvent } from "../../../utils/events";
import { isUnderPath, sameCwd } from "../../../utils/pathScope";
import { onTrustChange, revokeProject, trustProject } from "../../../utils/projectTrust";
import styles from "./ProjectSettingsView.module.css";

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

/**
 * Whether servers and formatters that run the project's own code may start.
 *
 * Trust is held by path prefix, so a project can be trusted through an entry
 * above it. That entry covers other projects too, which is why it is not
 * revoked from here: the tab would be taking trust away from projects it does
 * not name.
 */
export default function TrustSection(props: { projectPath: string }) {
  const [entries, { refetch }] = createResource(() => invoke<string[]>("trusted_projects"));
  onCleanup(onTrustChange(() => void refetch()));
  const [busy, setBusy] = createSignal(false);

  const own = () => (entries() ?? []).find((e) => sameCwd(e, props.projectPath));
  const via = () =>
    (entries() ?? [])
      .filter((e) => !sameCwd(e, props.projectPath) && isUnderPath(props.projectPath, e))
      .sort((a, b) => b.length - a.length)[0];

  async function run(verb: string, change: () => Promise<void>) {
    setBusy(true);
    try {
      await change();
    } catch (e) {
      toast(`Could not ${verb} this project: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class={styles.form}>
      <section class={styles.block}>
        <h3 class={styles.blockHead}>Trust</h3>
        <p class={styles.note}>
          Language servers, debuggers and formatters run code from the project itself, so they only start in a project
          you trust.
        </p>
        <Show when={entries.latest !== undefined}>
          <Show
            when={own()}
            fallback={
              <Show
                when={via()}
                fallback={
                  <div class={styles.actions}>
                    <span class={styles.actionHint}>Not trusted</span>
                    <Button
                      variant="primary"
                      disabled={busy()}
                      onClick={() => void run("trust", () => trustProject(props.projectPath))}
                    >
                      Trust
                    </Button>
                  </div>
                }
              >
                {(entry) => (
                  <>
                    <p class={styles.note}>
                      Trusted via <code class={styles.mono}>{entry()}</code>, which covers every project under it.
                      Revoke it from the trusted list in Settings.
                    </p>
                    <div class={styles.actions}>
                      <Button onClick={() => emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "trusted-projects" })}>
                        Open trusted projects
                      </Button>
                    </div>
                  </>
                )}
              </Show>
            }
          >
            {(entry) => (
              <div class={styles.actions}>
                <span class={styles.actionHint}>Trusted</span>
                <Button disabled={busy()} onClick={() => void run("revoke", () => revokeProject(entry()))}>
                  Revoke
                </Button>
              </div>
            )}
          </Show>
        </Show>
      </section>
    </div>
  );
}
