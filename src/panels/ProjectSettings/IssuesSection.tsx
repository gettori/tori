import { createEffect, createSignal, For, on, Show } from "solid-js";

import Button from "../../components/Button/Button";
import { emitWith, ISSUE_REPOS_CHANGED, TOAST, type IssueReposChanged, type ToastEvent } from "../../utils/events";
import {
  errorText,
  issueRepoAccess,
  issueRepos,
  setIssueRepos,
  type IssueRepos,
  type RepoAccess,
} from "../../utils/issues";
import { Section } from "./Section";
import s from "../Settings/Settings.module.css";
import styles from "./ProjectSettingsDialog.module.css";

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const ACCESS_LABEL: Record<RepoAccess["access"], string> = {
  readable: "Readable",
  unreadable: "No access",
  issuesOff: "Issues off",
};

/**
 * The repos this project's issues live in, one `owner/name` per line. Each is
 * checked against the project's account on load and after a save, and one it
 * cannot read stays listed, marked, since access can come later.
 */
export default function IssuesSection(props: { projectPath: string; onDirty?: (dirty: boolean) => void }) {
  const [repos, setRepos] = createSignal<IssueRepos | null>(null);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [access, setAccess] = createSignal<RepoAccess[] | null>(null);
  const [accessError, setAccessError] = createSignal<string | null>(null);

  function check(list: string[]) {
    setAccess(null);
    setAccessError(null);
    if (!list.length) return;
    issueRepoAccess(props.projectPath, list)
      .then(setAccess)
      .catch((e) => setAccessError(errorText(e)));
  }

  function show(r: IssueRepos) {
    setRepos(r);
    setText(r.stored.join("\n"));
    check(r.effective);
  }

  createEffect(
    on(
      () => props.projectPath,
      (path) =>
        void issueRepos(path)
          .then(show)
          .catch((e) => toast(errorText(e))),
    ),
  );

  const draft = () => lines(text());
  const dirty = () => draft().join("\n") !== (repos()?.stored ?? []).join("\n");
  createEffect(() => props.onDirty?.(dirty()));
  const origin = () => repos()?.origin ?? "this project's origin";

  async function save() {
    setBusy(true);
    try {
      show(await setIssueRepos(props.projectPath, draft()));
      emitWith<IssueReposChanged>(ISSUE_REPOS_CHANGED, { path: props.projectPath });
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section heading="Issues">
      <div class={styles.wide}>
        <p class={styles.lede}>
          The repos this project's issues live in, one owner/name per line. Empty: issues come from {origin()}. Once you
          add any repo, only the listed repos are searched, so add {origin()} too if its issues matter.
        </p>
        <textarea
          class={styles.textarea}
          classList={{ [styles.textareaDirty]: dirty() }}
          aria-label="Issue repos"
          rows={4}
          spellcheck={false}
          placeholder={repos()?.origin ?? "owner/name"}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div class={styles.actions}>
          <span class={styles.actionHint} classList={{ [styles.unsaved]: dirty() }}>
            {dirty() ? "Unsaved." : ""}
          </span>
          <Show when={dirty()}>
            <Button disabled={busy()} onClick={() => setText((repos()?.stored ?? []).join("\n"))}>
              Discard
            </Button>
          </Show>
          <Button variant="primary" disabled={!dirty() || busy()} onClick={() => void save()}>
            Save
          </Button>
        </div>
        <Show when={accessError()}>{(message) => <div class={s.hint}>{message()}</div>}</Show>
        <Show when={access()?.length}>
          <ul class={styles.repoValues} aria-label="Issue repo access">
            <For each={access()}>
              {(row) => (
                <li class={styles.repoValue}>
                  <span class={row.access === "readable" ? styles.badgeOn : styles.badge}>
                    {ACCESS_LABEL[row.access]}
                  </span>
                  <code class={styles.repoText}>{row.repo}</code>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Section>
  );
}
