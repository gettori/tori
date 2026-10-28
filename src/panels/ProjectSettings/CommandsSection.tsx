import Switch from "../../components/Switch/Switch";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { repoValues, type Answered } from "../../utils/proposals";
import { rememberWorktreePrefs, worktreePrefs, type WorktreePrefs } from "../Settings/settingsStore";
import s from "../Settings/Settings.module.css";
import RepoValues from "./RepoValues";
import { Row, Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

/** The commands a project's worktrees run when created, on demand and when
 *  removed. A field left empty shows what the repo's accepted
 *  `.tori/project.json` runs instead, and typing one overrides them all. */
export default function CommandsSection(props: { projectPath: string; answered: Answered[] | undefined }) {
  const setup = () => worktreePrefs(props.projectPath);
  function saveSetup(patch: Partial<WorktreePrefs>) {
    rememberWorktreePrefs(props.projectPath, patch).catch((e) =>
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }),
    );
  }
  const repo = (key: "setupCommand" | "runCommand" | "teardownCommand") => repoValues(props.answered, key);

  return (
    <Section heading="Commands">
      <Row
        stack
        label="Setup command"
        hint={
          <>
            Runs with <code>sh -c</code> in each worktree Tori creates here, with <code>TORI_PROJECT_ROOT</code> and{" "}
            <code>TORI_WORKTREE_PATH</code> set. A fork's pull request never runs it.
          </>
        }
      >
        <div class={styles.field}>
          <input
            type="text"
            class={`${s.input} ${s.text}`}
            aria-label="Setup command"
            value={setup().setupCommand}
            placeholder="pnpm install"
            onChange={(e) => saveSetup({ setupCommand: e.currentTarget.value.trim() })}
          />
          <RepoValues values={repo("setupCommand")} overridden={!!setup().setupCommand} />
        </div>
      </Row>
      <Row label="Agents started over the socket wait for it">
        <Switch
          checked={setup().setupWait}
          onChange={(on) => saveSetup({ setupWait: on })}
          aria-label="Agents started over the socket wait for it"
        />
      </Row>
      <Row
        stack
        label="Run command"
        hint={
          <>
            Started and stopped by hand from a worktree's row or the palette, a dev server usually. Runs in the
            background with <code>sh -c</code>, its output in a log, with <code>TORI_PORT</code> set. A fork's pull
            request never runs it.
          </>
        }
      >
        <div class={styles.field}>
          <input
            type="text"
            class={`${s.input} ${s.text}`}
            aria-label="Run command"
            value={setup().runCommand}
            placeholder="pnpm dev --port $TORI_PORT"
            onChange={(e) => saveSetup({ runCommand: e.currentTarget.value.trim() })}
          />
          <RepoValues values={repo("runCommand")} overridden={!!setup().runCommand} />
        </div>
      </Row>
      <Row
        label="Open the browser when a server starts"
        hint="Once the run command's server listens, its first port opens in the browser, or the tab already on it comes to the front."
      >
        <Switch
          checked={setup().openBrowser}
          onChange={(on) => saveSetup({ openBrowser: on })}
          aria-label="Open the browser when a server starts"
        />
      </Row>
      <Row
        label="Start the run command when a worktree is created"
        hint="Only for a worktree you create from the sidebar, once its setup command finishes without an error. Agents and attempts never start it."
      >
        <Switch
          checked={setup().runOnCreate}
          disabled={!setup().runCommand && !repo("runCommand").length}
          onChange={(on) => saveSetup({ runOnCreate: on })}
          aria-label="Start the run command when a worktree is created"
        />
      </Row>
      <Row
        stack
        label="Teardown command"
        hint={
          <>
            Runs with <code>sh -c</code> before Tori removes a worktree here, with <code>TORI_PROJECT_ROOT</code>,{" "}
            <code>TORI_WORKTREE_PATH</code> and <code>TORI_PORT</code> set. The removal goes ahead if it fails or runs
            past 2 minutes. A fork's pull request never runs it.
          </>
        }
      >
        <div class={styles.field}>
          <input
            type="text"
            class={`${s.input} ${s.text}`}
            aria-label="Teardown command"
            value={setup().teardownCommand}
            placeholder="docker compose down"
            onChange={(e) => saveSetup({ teardownCommand: e.currentTarget.value.trim() })}
          />
          <RepoValues values={repo("teardownCommand")} overridden={!!setup().teardownCommand} />
        </div>
      </Row>
    </Section>
  );
}
