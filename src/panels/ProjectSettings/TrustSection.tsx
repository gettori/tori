import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { TriangleAlert } from "lucide-solid";

import Button from "../../components/Button/Button";
import Icon from "../../components/Icon/Icon";
import { emitWith, OPEN_SETTINGS, TOAST, type OpenSettings, type ToastEvent } from "../../utils/events";
import { isUnderPath, sameCwd } from "../../utils/pathScope";
import { onTrustChange, revokeProject, trustProject } from "../../utils/projectTrust";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

/**
 * Whether servers and formatters that run the project's own code may start.
 *
 * Trust is held by path prefix, so a project can be trusted through an entry
 * above it. That entry covers other projects too, which is why it is not
 * revoked from here: the dialog would be taking trust away from projects it does
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

  const why =
    "Language servers, debuggers and formatters run code from the project itself, so they only start in a project you trust.";

  return (
    <Section heading="Trust">
      <Show when={entries.latest !== undefined}>
        <Show
          when={own()}
          fallback={
            <Show
              when={via()}
              fallback={
                <div class={styles.warnCard} role="group" aria-label="Not trusted">
                  <Icon icon={TriangleAlert} />
                  <div class={styles.warnText}>
                    <span class={styles.warnTitle}>Not trusted</span>
                    <span class={styles.warnBody}>{why}</span>
                  </div>
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
                <Row
                  label="Trusted"
                  hint={
                    <>
                      Through <code class={styles.mono}>{entry()}</code>, which covers every project under it, so it is
                      revoked from the trusted list in Settings.
                    </>
                  }
                >
                  <Button onClick={() => emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "trusted-projects" })}>
                    Open trusted projects
                  </Button>
                </Row>
              )}
            </Show>
          }
        >
          {(entry) => (
            <Row label="Trusted" hint={why}>
              <Button disabled={busy()} onClick={() => void run("revoke", () => revokeProject(entry()))}>
                Revoke
              </Button>
            </Row>
          )}
        </Show>
      </Show>
    </Section>
  );
}
