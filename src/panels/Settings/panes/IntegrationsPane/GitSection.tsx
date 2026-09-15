import { createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import Button from "../../../../components/Button/Button";
import { OPEN_JOB, emitWith, type OpenJob } from "../../../../utils/events";
import { gitInstallJob, type GitHealth, type GitReport } from "../../../../utils/gitHealth";
import styles from "../../Settings.module.css";

type Missing = Exclude<GitHealth["kind"], "ready">;

const STATUS: Record<Missing, string> = {
  toolsMissing: "macOS ships git inside its Command Line Tools, which are not installed.",
  notFound: "git is not on your login shell PATH.",
};

const WAITING: Record<Missing, string> = {
  toolsMissing: "The installer opened in its own window. Check again when it finishes.",
  notFound: "Homebrew is installing git in a terminal tab. Check again when it finishes.",
};

const INSTALL_LABEL: Record<Missing, string> = {
  toolsMissing: "Install Command Line Tools",
  notFound: "Install with Homebrew",
};

export default function GitSection() {
  const [report, setReport] = createSignal<GitReport | null>(null);
  const [started, setStarted] = createSignal(false);

  const probe = (command: "git_health" | "refresh_git_health") =>
    invoke<GitReport>(command)
      .then(setReport)
      .catch(() => {});
  void probe("git_health");

  // Apple's installer runs in its own window, so coming back to Sway is the
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
          <div class={styles.monogram} aria-hidden="true">
            git
          </div>
          <div class={styles.connectMain}>
            <div class={styles.connectTitle}>
              {ready()?.version ? `git ${ready()!.version}` : "git"}
            </div>
            <div class={styles.cardStatus}>
              <Show when={missing()} fallback={<code>{ready()?.path}</code>}>
                {(kind) => <>{(started() ? WAITING : STATUS)[kind()]}</>}
              </Show>
            </div>
          </div>
          <span class={`${styles.statePill} ${ready() ? styles.statePillOk : ""}`}>
            {ready() ? "Ready" : "Not installed"}
          </span>
          <Show when={missing()}>
            {(kind) => (
              <>
                <Show when={!started() && report()?.install.type === "terminal"}>
                  <Button variant="primary" onClick={() => void install()}>
                    {INSTALL_LABEL[kind()]}
                  </Button>
                </Show>
                <Button
                  onClick={() => void probe("refresh_git_health").then(() => setStarted(false))}
                >
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
