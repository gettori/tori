import { For, Show, onMount, type JSX } from "solid-js";
import Button from "../../../components/Button/Button";
import SegmentedControl from "../../../components/SegmentedControl/SegmentedControl";
import type { FirstRunSpace } from "../../../utils/firstRun";
import type { GitHealth, GitReport } from "../../../utils/gitHealth";
import type { InstallRoute } from "../../../utils/install";
import { badName, shortHome } from "../../../utils/names";
import type { NewProjectMode } from "../../../utils/newProject";
import { commandLine } from "./AgentsStep";
import styles from "../FirstRun.module.css";

export const PROJECT_LEAD =
  "Projects live inside the space. Start empty, clone a repo, or set up a bare repo with one worktree per branch.";

export const PROJECT_LABEL: Record<NewProjectMode, string> = {
  folder: "Create project",
  clone: "Clone",
  bare: "Set up worktrees",
};

const MODES: { value: NewProjectMode; label: string }[] = [
  { value: "folder", label: "New folder" },
  { value: "clone", label: "Clone" },
  { value: "bare", label: "Bare + worktrees" },
];

const MODE_HINT: Record<NewProjectMode, string> = {
  folder: "An empty project folder in the space.",
  clone: "Clone a repository URL into the space.",
  bare: "One bare repo, with each branch you work on checked out as its own sibling folder. Best for running several agents on different branches at once.",
};

// A git without Git Bash still clones; Settings is where that gap is shown.
type GitMissing = Exclude<GitHealth["kind"], "ready" | "bashMissing">;

const GIT_MISSING: Record<GitMissing, string> = {
  toolsMissing: "Cloning and worktrees need git on your PATH. The Xcode command line tools include it.",
  notFound: "Cloning and worktrees need git on your login shell's PATH. Homebrew can install it.",
};

/** git is only a question for the modes that run it, and an unanswered probe
 *  is not an answer. */
export function gitMissing(
  mode: NewProjectMode,
  git: GitReport | null,
): { kind: GitMissing; install: Extract<InstallRoute, { type: "terminal" }> | null } | null {
  if (mode === "folder" || !git || git.health.kind === "ready" || git.health.kind === "bashMissing") return null;
  return { kind: git.health.kind, install: git.install.type === "terminal" ? git.install : null };
}

export default function ProjectStep(props: {
  space: FirstRunSpace;
  home: string;
  mode: NewProjectMode;
  onMode: (mode: NewProjectMode) => void;
  name: string;
  onName: (name: string) => void;
  url: string;
  onUrl: (url: string) => void;
  error?: string | null;
  git: GitReport | null;
  busy?: boolean;
  /** Something was created on this visit, which the found list would only
   *  repeat back as already there. */
  settled?: boolean;
  /** Enter in a field. The primary lives in the footer, out of the fields'
   *  reach, so the step forwards the key. */
  onSubmit: () => void;
  onInstallGit: () => void;
  onCheckGit: () => void;
  job?: JSX.Element;
}) {
  const needsUrl = () => props.mode !== "folder";
  const target = () => shortHome(`${props.space.path}/${props.name.trim() || "..."}`, props.home);
  const preview = () =>
    props.mode === "bare" ? `Creates ${target()}/.bare plus a worktree for the default branch` : `Creates ${target()}`;
  const nameError = () => (props.name.trim() === "" ? null : badName(props.name));
  const plural = (n: number) => `${n} project${n === 1 ? "" : "s"}`;

  // Only the field the step opens on: a field that appears later, on a mode
  // switch, would take focus off the segment the user just pressed.
  let opening = true;
  onMount(() => (opening = false));
  const focusFirst = (el: HTMLInputElement) => opening && queueMicrotask(() => el.focus());

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    props.onSubmit();
  };

  return (
    <>
      <fieldset class={styles.fieldset} disabled={props.busy}>
        <SegmentedControl
          class={styles.modes}
          aria-label="What to create"
          options={MODES}
          value={props.mode}
          onChange={props.onMode}
        />
        <div class={styles.note}>{MODE_HINT[props.mode]}</div>

        <Show
          when={gitMissing(props.mode, props.git)}
          fallback={
            <>
              <div class={styles.fields}>
                <div class={`${styles.field} ${styles.fieldName}`}>
                  <label class={styles.fieldLabel} for="first-run-project-name">
                    Name
                  </label>
                  <input
                    id="first-run-project-name"
                    ref={(el) => !needsUrl() && focusFirst(el)}
                    class={styles.input}
                    type="text"
                    value={props.name}
                    placeholder="api"
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(e) => props.onName(e.currentTarget.value)}
                    onKeyDown={onKeyDown}
                  />
                </div>
                <Show when={needsUrl()}>
                  <div class={`${styles.field} ${styles.fieldUrl}`}>
                    <label class={styles.fieldLabel} for="first-run-project-url">
                      Repository URL
                    </label>
                    <input
                      id="first-run-project-url"
                      ref={focusFirst}
                      class={styles.input}
                      type="text"
                      value={props.url}
                      placeholder="git@github.com:acme/api.git"
                      autocomplete="off"
                      spellcheck={false}
                      onInput={(e) => props.onUrl(e.currentTarget.value)}
                      onKeyDown={onKeyDown}
                    />
                  </div>
                </Show>
              </div>
              <Show when={nameError() ?? props.error} fallback={<div class={styles.preview}>{preview()}</div>}>
                {(err) => <div class={styles.error}>{err()}</div>}
              </Show>
            </>
          }
        >
          {(git) => (
            <div class={`${styles.card} ${styles.stack}`}>
              <div class={styles.cardTitle}>git is not installed</div>
              <div>{GIT_MISSING[git().kind]}</div>
              <div class={styles.row}>
                <Show when={git().install}>
                  {(route) => (
                    <>
                      <code class={styles.commandChip}>{commandLine(route())}</code>
                      <Button size="sm" onClick={() => props.onInstallGit()}>
                        Install
                      </Button>
                    </>
                  )}
                </Show>
                <button type="button" class={styles.link} onClick={() => props.onCheckGit()}>
                  Check again
                </button>
              </div>
            </div>
          )}
        </Show>
      </fieldset>

      <Show when={!props.settled && props.space.projects.length > 0}>
        <div class={`${styles.card} ${styles.stack}`}>
          <div class={styles.cardTitle}>
            {plural(props.space.projects.length)} already in {shortHome(props.space.path, props.home)}
          </div>
          <div class={styles.chips}>
            <For each={props.space.projects}>{(p) => <span class={styles.chip}>{p.name}</span>}</For>
          </div>
          <div>Nothing to create. Continue, or add one anyway with the options above.</div>
        </div>
      </Show>

      {props.job}
    </>
  );
}
