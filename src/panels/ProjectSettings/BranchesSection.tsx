import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import Button from "../../components/Button/Button";
import ChangeOriginDialog from "../../components/Dialogs/ChangeOriginDialog";
import Select from "../../components/Select/Select";
import { emitWith, OPEN_SETTINGS, TOAST, type OpenSettings, type ToastEvent } from "../../utils/events";
import { forgeAccountsOn, forgeRepo, pickForgeAccount, resolveForgeRepo } from "../../utils/forgeStatus";
import { forgeAccountName, forgeErrorMessage } from "../../utils/forgeTypes";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

/**
 * Where the repo points and who it acts as: origin, the forge account, and the
 * branch origin calls its default.
 *
 * The account is held per remote, not per project, so the note says so: two
 * checkouts of one repository share one pick.
 */
export default function BranchesSection(props: { projectPath: string; projectName: string }) {
  const [origin, { refetch: refetchOrigin }] = createResource(
    () => props.projectPath,
    (path) => invoke<string | null>("git_origin", { projectPath: path }).catch(() => null),
  );
  const [base, { refetch: refetchBase }] = createResource(
    () => props.projectPath,
    (repo) => invoke<string | null>("repo_default_branch", { repo }).catch(() => null),
  );
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // `git_remote_add` emits `config://changed`, as does anything else that moves
  // a remote, so one listener covers a change made here and one made elsewhere.
  let unlisten: (() => void) | undefined;
  onMount(async () => {
    unlisten = await listen("config://changed", () => {
      void refetchOrigin();
      void refetchBase();
      void resolveForgeRepo(props.projectPath);
    });
  });
  onCleanup(() => unlisten?.());
  void resolveForgeRepo(props.projectPath);

  async function setOrigin(url: string) {
    setBusy(true);
    try {
      await invoke("git_remote_add", { projectPath: props.projectPath, url });
      setEditing(false);
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }

  const repo = () => forgeRepo(props.projectPath);
  const host = () => repo()?.host ?? null;
  const accountOptions = () => {
    const r = repo();
    if (!r?.host) return [];
    const list = r.kind === "pick" ? r.candidates : forgeAccountsOn(r.host);
    return list.map((a) => ({ value: a.id, label: forgeAccountName(a) }));
  };
  const current = () => {
    const r = repo();
    return r?.kind === "account" ? r.accountId : "";
  };

  return (
    <Section heading="Remote">
      <Row label="Origin" hint={<span class={styles.mono}>{origin() ?? "None set"}</span>}>
        <Button onClick={() => setEditing(true)}>{origin() ? "Change origin" : "Set origin"}</Button>
      </Row>
      <Row label="Default branch" hint="What origin calls its default branch.">
        <span class={styles.value}>{base() ?? "Unknown"}</span>
      </Row>
      {/* Hidden on an origin no forge serves: there is no account to pick. */}
      <Show when={host()}>
        {(h) => (
          <Row
            label="Account"
            hint={
              repo()?.kind === "pick"
                ? `More than one account is added for ${h()}. Pick the one this repo uses for pull requests and checks.`
                : "Used for pull requests and checks. Kept per remote, so every project on this origin shares it."
            }
          >
            <Show
              when={accountOptions().length}
              fallback={
                <>
                  <span class={styles.value}>No {h()} account</span>
                  <Button variant="primary" onClick={() => emitWith<OpenSettings>(OPEN_SETTINGS, { entry: "forge" })}>
                    Add an account
                  </Button>
                </>
              }
            >
              <Select
                aria-label={`Account for ${props.projectName}`}
                placeholder="Pick an account"
                options={accountOptions()}
                value={current()}
                onChange={(id) =>
                  void pickForgeAccount(props.projectPath, id).catch((e) => toast(forgeErrorMessage(e)))
                }
              />
            </Show>
          </Row>
        )}
      </Show>

      <Show when={editing()}>
        <ChangeOriginDialog
          projectName={props.projectName}
          current={origin() ?? null}
          busy={busy()}
          onConfirm={(url) => void setOrigin(url)}
          onCancel={() => setEditing(false)}
        />
      </Show>
    </Section>
  );
}
