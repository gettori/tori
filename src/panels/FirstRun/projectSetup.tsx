import { Show, createEffect, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Check } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import type { OpenJob } from "../../utils/events";
import { reloadFirstRunConfig, type FirstRunSpace } from "../../utils/firstRun";
import { gitInstallJob, type GitReport } from "../../utils/gitHealth";
import { badName, shortHome } from "../../utils/names";
import { claimProjectFolder, nameFromUrl, projectJob, type NewProjectMode } from "../../utils/newProject";
import InlineJob from "./job/InlineJob";
import type { JobState } from "./job/InlineJobFrame";
import ProjectStep, { PROJECT_LABEL, gitMissing } from "./steps/ProjectStep";
import styles from "./FirstRun.module.css";

type StepJob =
  | { kind: "project"; job: OpenJob; mode: "clone" | "bare"; space: FirstRunSpace; name: string }
  | { kind: "git"; job: OpenJob };

/** A factory for the same reason as `createAgentsSetup`: the footer's primary
 *  and the rail read what this step knows. */
export function createProjectSetup(opts: {
  home: () => string;
  space: () => FirstRunSpace | null;
  onScreen: () => boolean;
  onDone: () => void;
}) {
  const [mode, setMode] = createSignal<NewProjectMode>("clone");
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  // A typed name wins over the one read off the URL.
  const [nameEdited, setNameEdited] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [job, setJob] = createSignal<StepJob | null>(null);
  const [jobState, setJobState] = createSignal<JobState | null>(null);
  const [settled, setSettled] = createSignal(false);
  const [made, setMade] = createSignal<{ space: FirstRunSpace; name: string } | null>(null);
  const [git, setGit] = createSignal<GitReport | null>(null);
  const [checkingGit, setCheckingGit] = createSignal(false);

  const running = () => creating() || jobState() === "running" || jobState() === "waiting";

  onMount(() => {
    invoke<GitReport>("git_health")
      .then(setGit)
      .catch(() => {
        // Left unanswered, the step offers clone as if git were there, and
        // the clone's own output says otherwise.
      });
  });

  // As on the agents step: a job left behind would mount, and so run, again.
  createEffect(() => {
    if (opts.onScreen()) return;
    clearJob();
    setSettled(false);
    setError(null);
  });

  function clearJob() {
    setJob(null);
    setJobState(null);
  }

  function edited() {
    setError(null);
    setSettled(false);
    if (job() && !running()) clearJob();
  }

  function onMode(next: NewProjectMode) {
    setMode(next);
    edited();
  }

  function onName(next: string) {
    setName(next);
    setNameEdited(true);
    edited();
  }

  function onUrl(next: string) {
    setUrl(next);
    if (!nameEdited()) setName(nameFromUrl(next.trim()));
    edited();
  }

  function created(space: FirstRunSpace, projectName: string) {
    setMade({ space, name: projectName });
    setSettled(true);
    setName("");
    setUrl("");
    setNameEdited(false);
  }

  const canCreate = () => !badName(name()) && (mode() === "folder" || url().trim() !== "");

  async function create() {
    const space = opts.space();
    if (!space || !canCreate() || running()) return;
    const m = mode();
    const n = name().trim();
    setError(null);
    setCreating(true);
    try {
      if (m === "folder") {
        await invoke("add_folder", { spacePath: space.path, name: n });
        await reloadFirstRunConfig();
        created(space, n);
        return;
      }
      const refused = await claimProjectFolder(space.path, n);
      if (refused) return setError(refused);
      // Interactive, unlike the dock's clone: nothing else in the modal takes
      // keys, and a passphrase prompt needs them.
      const job = { ...projectJob(m, space.path, n, url()), interactive: true };
      setJob({ kind: "project", job, mode: m, space, name: n });
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function checkGit() {
    setCheckingGit(true);
    try {
      setGit(await invoke<GitReport>("refresh_git_health"));
    } catch {
      // The card stays as it was.
    } finally {
      setCheckingGit(false);
    }
  }

  function installGit() {
    const report = git();
    const next = report && gitInstallJob(report.install, opts.home() || "/");
    if (next) setJob({ kind: "git", job: next });
  }

  function onJobState(j: StepJob, state: JobState) {
    setJobState(state);
    if (state !== "ok") return;
    if (j.kind === "project") created(j.space, j.name);
    else void checkGit();
  }

  const madePath = (space: FirstRunSpace, projectName: string) => shortHome(`${space.path}/${projectName}`, opts.home());

  function okLine(j: StepJob): string {
    if (j.kind === "project") {
      const where = madePath(j.space, j.name);
      return j.mode === "clone" ? `Cloned into ${where}` : `Bare repo and worktree set up in ${where}`;
    }
    const health = git()?.health;
    if (checkingGit()) return "Checking for git";
    if (health?.kind === "ready") return health.version ? `git ${health.version} installed` : "git installed";
    // Apple's installer is a window of its own, so the command exits long
    // before git exists.
    if (health?.kind === "toolsMissing") return "The installer opened in its own window. Check again when it finishes.";
    return "Install finished, but Tori still cannot find git on your login shell's PATH";
  }

  const needsGit = () => gitMissing(mode(), git()) !== null;
  const found = () => (opts.space()?.projects.length ?? 0) > 0;
  const nothingTyped = () => name().trim() === "" && url().trim() === "";

  /** The footer's primary. Continue once there is nothing this step has to
   *  make: something was made, the space already has projects, or git is
   *  missing for the mode picked. */
  const primary = (): { label: string; disabled: boolean; run: () => void } => {
    if (running()) return { label: PROJECT_LABEL[mode()], disabled: true, run: () => {} };
    if (settled() || needsGit() || (found() && nothingTyped())) {
      return { label: "Continue", disabled: false, run: opts.onDone };
    }
    return { label: PROJECT_LABEL[mode()], disabled: !canCreate(), run: () => void create() };
  };

  const summary = () => {
    const space = opts.space();
    if (!space) return null;
    const m = made();
    if (m) return `${m.space.name}/${m.name}`;
    return space.projects.length > 0 ? `${space.projects.length} found` : null;
  };

  const view = () => (
    <Show when={opts.space()}>
      {(space) => (
        <ProjectStep
          space={space()}
          home={opts.home()}
          mode={mode()}
          onMode={onMode}
          name={name()}
          onName={onName}
          url={url()}
          onUrl={onUrl}
          error={error()}
          git={git()}
          busy={running() || checkingGit()}
          settled={settled()}
          onSubmit={() => {
            const p = primary();
            if (!p.disabled) p.run();
          }}
          onInstallGit={installGit}
          onCheckGit={() => void checkGit()}
          job={
            <Show
              when={job()}
              keyed
              fallback={
                <Show when={settled() && made()}>
                  {(m) => (
                    <div class={styles.made}>
                      <Icon icon={Check} size={14} strokeWidth={2.5} />
                      Created {madePath(m().space, m().name)}
                    </div>
                  )}
                </Show>
              }
            >
              {(j) => <InlineJob job={j.job} okLine={okLine(j)} onCancel={clearJob} onState={(st) => onJobState(j, st)} />}
            </Show>
          }
        />
      )}
    </Show>
  );

  return { view, running, summary, primary, made };
}
