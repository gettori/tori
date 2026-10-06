import { createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import Button from "../../../../components/Button/Button";
import { GitLogo } from "../../../../components/Icon/gitMarks";
import { OPEN_JOB, emitWith, type OpenJob } from "../../../../utils/events";
import { gitInstallJob, type GitHealth, type GitReport } from "../../../../utils/gitHealth";
import styles from "../../Settings.module.css";
import { isWindows } from "../../../../utils/platform";

type Missing = Exclude<GitHealth["kind"], "ready">;

const STATUS: Record<Missing, string> = {
  bashMissing: "This git has no Git Bash beside it. Setup commands, agent hooks and the credential helper run in it.",
  toolsMissing: "macOS ships git inside its Command Line Tools, which are not installed.",
  notFound: isWindows ? "git is not on your PATH." : "git is not on your login shell PATH.",
};

const WAITING: Record<Missing, string> = {
  bashMissing: "winget is installing Git for Windows in a terminal tab. Check again when it finishes.",
  toolsMissing: "The installer opened in its own window. Check again when it finishes.",
  notFound: `${isWindows ? "winget is installing Git for Windows" : "Homebrew is installing git"} in a terminal tab. Check again when it finishes.`,
};

const INSTALL_LABEL: Record<Missing, string> = {
  bashMissing: "Install Git for Windows",
  toolsMissing: "Install Command Line Tools",
  notFound: isWindows ? "Install Git for Windows" : "Install with Homebrew",
};

export default function GitSection() {
  const [report, setReport] = createSignal<GitReport | null>(null);
  const [started, setStarted] = createSignal(false);

  const probe = (command: "git_health" | "refresh_git_health") =>
    invoke<GitReport>(command)
      .then(setReport)
      .catch(() => {});
  void probe("git_health");

  // Apple's installer runs in its own window, so coming back to Tori is the
  // moment it may have finished.
  const onFocus = () => {
    if (report()?.health.kind !== "ready") void probe("refresh_git_health");
  };
  window.addEventListener("focus", onFocus);
  onCleanup(() => window.removeEventListener("focus", onFocus));

  const ready = () => {
    const h = report()?.health;
    return h?.kind === "ready" ? h : null;
  };
  const missing = (): Missing | null => {
    const h = report()?.health;
    return h && h.kind !== "ready" ? h.kind : null;
  };

  async function install() {
    const r = report();
    if (!r) return;
    const job = gitInstallJob(r.install, await homeDir().catch(() => "/"));
    if (!job) return;
    emitWith<OpenJob>(OPEN_JOB, job);
    setStarted(true);
  }

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Git</span>
        <span class={styles.sectionRule} />
      </div>

      <Show when={report()}>
        <div class={styles.connect}>
          <div class={styles.connectGlyph} aria-hidden="true">
            <GitLogo size="calc(34px * var(--ui-scale))" />
          </div>
          <div class={styles.connectMain}>
            <div class={styles.connectTitle}>{ready()?.version ? `git ${ready()!.version}` : "git"}</div>
            <div class={styles.cardStatus}>
              <Show when={missing()} fallback={<code>{ready()?.path}</code>}>
                {(kind) => <>{(started() ? WAITING : STATUS)[kind()]}</>}
              </Show>
            </div>
          </div>
          <span class={`${styles.statePill} ${ready() ? styles.statePillOk : ""}`}>
            {ready() ? "Ready" : missing() === "bashMissing" ? "Incomplete" : "Not installed"}
          </span>
          <Show when={missing()}>
            {(kind) => (
              <>
                <Show when={!started() && report()?.install.type === "terminal"}>
                  <Button variant="primary" onClick={() => void install()}>
                    {INSTALL_LABEL[kind()]}
                  </Button>
                </Show>
                <Button onClick={() => void probe("refresh_git_health").then(() => setStarted(false))}>
                  Check again
                </Button>
              </>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
