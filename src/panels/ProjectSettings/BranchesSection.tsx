import { createDeferred, createSignal, For, onSettled, refresh, Show, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import Button from "../../components/Button/Button";
import ChangeOriginDialog from "../../components/Dialogs/ChangeOriginDialog";
import Select from "../../components/Select/Select";
import { emitWith, OPEN_SETTINGS, TOAST, type OpenSettings, type ToastEvent } from "../../utils/events";
import {
  accountWithAccess,
  forgeAccountsOn,
  forgeRepo,
  pickForgeAccount,
  resolveForgeRepo,
} from "../../utils/forgeStatus";
import { forgeAccountName, forgeErrorMessage, type CommitIdentity } from "../../utils/forgeTypes";
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
  const origin = createDeferred<string | null | undefined>(
    (was) => {
      const path = props.projectPath;
      if (!path) return was;
      return invoke<string | null>("git_origin", { projectPath: path }).catch(() => null);
    },
    { loadingValue: undefined },
  );
  const base = createDeferred<string | null | undefined>(
    (was) => {
      const repo = props.projectPath;
      if (!repo) return was;
      return invoke<string | null>("repo_default_branch", { repo }).catch(() => null);
    },
    { loadingValue: undefined },
  );
  const author = createDeferred<CommitIdentity | null | undefined>(
    (was) => {
      const projectPath = props.projectPath;
      if (!projectPath) return was;
      return invoke<CommitIdentity | null>("forge_commit_identity", { projectPath }).catch(() => null);
    },
    { loadingValue: undefined },
  );
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // `git_remote_add` emits `config://changed`, as does anything else that moves
  // a remote, so one listener covers a change made here and one made elsewhere.
  onSettled(() => {
    const unlisten = listen("config://changed", () => {
      void refresh(origin);
      void refresh(base);
      void refresh(author);
      void resolveForgeRepo(untrack(() => props.projectPath));
    });
    return () => void unlisten.then((stop) => stop());
  });
  void resolveForgeRepo(untrack(() => props.projectPath));

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
    return list.map((a) => ({
      value: a.id,
      label: r.kind === "pick" ? accountWithAccess(props.projectPath, a) : forgeAccountName(a),
    }));
  };
  const current = () => {
    const r = repo();
    return r?.kind === "account" ? r.accountId : "";
  };
  const accountName = (id: string) => {
    const a = forgeAccountsOn(host() ?? "").find((x) => x.id === id);
    return a ? forgeAccountName(a) : id;
  };

  async function authorAction(command: string, args: Record<string, unknown> = {}) {
    try {
      await invoke(command, { projectPath: props.projectPath, ...args });
    } catch (e) {
      toast(forgeErrorMessage(e));
    }
    void refresh(author);
  }

  const authorHint = (a: CommitIdentity) => {
    switch (a.source.kind) {
      case "account":
        return `From ${accountName(a.source.accountId)}, for every git client in this repo.`;
      case "repo":
        return "Set in this repo's own git config.";
      case "global": {
        const r = repo();
        return r?.kind === "account"
          ? `Your global git author. Give ${accountName(r.accountId)} an author in Settings to commit as it here.`
          : "Your global git author.";
      }
      case "include":
        return `From ${a.source.file}.`;
      case "none":
        return "No author is set, so git will refuse to commit.";
    }
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
                  void pickForgeAccount(props.projectPath, id)
                    .catch((e) => toast(forgeErrorMessage(e)))
                    .then(() => refresh(author))
                }
              />
            </Show>
          </Row>
        )}
      </Show>
      <Show when={author()}>
        {(a) => (
          <Row
            label="Commits as"
            hint={
              <>
                <div>{authorHint(a())}</div>
                <Show when={a().needsChoice}>
                  {(id) => (
                    <div>
                      This repo sets its own author, so {accountName(id())}'s is not applied here. Using{" "}
                      {accountName(id())} ignores the repo's own author ({a().email ?? "none"}) until you switch back.
                    </div>
                  )}
                </Show>
                <For each={a().ignored}>
                  {(own) => (
                    <div>
                      This repo's own {own.key} ({own.value}) is ignored.{" "}
                      <Show when={own.removable}>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void authorAction("forge_identity_remove_own", { key: own.key })}
                        >
                          Remove it
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
              </>
            }
          >
            <span class={styles.value}>{a().email ? `${a().name ?? ""} <${a().email}>` : "Not set"}</span>
            <Show when={a().needsChoice}>
              {(id) => <Button onClick={() => void authorAction("forge_identity_use")}>Use {accountName(id())}</Button>}
            </Show>
            <Show when={a().ignored.length > 0}>
              <Button onClick={() => void authorAction("forge_identity_stop")}>Use the repo's own</Button>
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
