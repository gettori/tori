import { For, Match, Show, Switch } from "solid-js";
import { Folder } from "lucide-solid";
import Button from "../../../components/Button/Button";
import GroupProjects from "../../../components/GroupProjects/GroupProjects";
import Icon from "../../../components/Icon/Icon";
import type { FirstRunSpace } from "../../../utils/firstRun";
import type { Plan, RootScan } from "../../../utils/grouping";
import { shortHome } from "../../../utils/names";
import styles from "../FirstRun.module.css";

export const DEFAULT_BASE = "tori_projects";

export type Pending = { scan: RootScan; plan: Plan | null };

export const BASE_FOLDER_LEAD = (
  <>
    Tori scans one folder and reads it as <code>&lt;base&gt;/&lt;space&gt;/&lt;project&gt;</code>. Pick the folder you
    already keep repos in, like ~/Projects. Not your home folder, and not a single repo. Nothing is moved or changed.
  </>
);

export default function BaseFolderStep(props: {
  root: string | null;
  spaces: FirstRunSpace[];
  home: string;
  busy?: boolean;
  onChoose: () => void;
  pending?: Pending | null;
  onPlan?: (plan: Plan) => void;
  onCreate?: () => void;
  onDefault?: () => void;
}) {
  const found = () => props.spaces;
  const projects = () => found().reduce((n, s) => n + s.projects.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const settled = () => (
    <Show
      when={props.root}
      fallback={
        <>
          <div class={styles.row}>
            <Button variant="primary" disabled={props.busy} onClick={() => props.onChoose()}>
              Choose folder
            </Button>
            <span class={styles.hint}>Opens the macOS folder picker.</span>
          </div>
          <div class={styles.placeholder}>No folder chosen yet</div>
        </>
      }
    >
      {(root) => (
        <>
          <div class={styles.row}>
            <div class={styles.pathField}>
              <Icon icon={Folder} />
              <span class={styles.pathText}>{shortHome(root(), props.home)}</span>
            </div>
            <Button disabled={props.busy} onClick={() => props.onChoose()}>
              Change
            </Button>
          </div>
          <Show
            when={found().length > 0}
            fallback={
              <>
                <div class={styles.note}>Empty folder. Nothing to scan yet.</div>
                <div class={styles.card}>
                  That is fine. The next step creates a space inside it, which is all Tori needs to open.
                </div>
              </>
            }
          >
            <div class={styles.note}>
              <span class={styles.found}>Found</span> {plural(found().length, "space")}, {plural(projects(), "project")}
              , so the space step is already answered
            </div>
            <div class={`${styles.card} ${styles.scan}`}>
              <span class={styles.hint}>{shortHome(root(), props.home)}</span>
              <For each={found()}>
                {(s) => (
                  <div class={styles.scanRow}>
                    <span>{s.name}</span>
                    <span>{plural(s.projects.length, "project")}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </>
      )}
    </Show>
  );

  const chosen = (path: string) => (
    <div class={styles.row}>
      <div class={styles.pathField}>
        <Icon icon={Folder} />
        <span class={styles.pathText}>{shortHome(path, props.home)}</span>
      </div>
      <Button disabled={props.busy} onClick={() => props.onChoose()}>
        Change
      </Button>
    </div>
  );

  return (
    <Switch fallback={settled()}>
      <Match when={props.pending?.scan.refused ? props.pending : null}>
        {(p) => (
          <>
            {chosen(p().scan.base)}
            <div class={styles.error}>{p().scan.refused}</div>
            <div class={styles.card}>
              <p>Pick another folder, make a new one, or let Tori make ~/{DEFAULT_BASE} for you.</p>
              <div class={styles.row}>
                <Button disabled={props.busy} onClick={() => props.onChoose()}>
                  Choose another folder
                </Button>
                <Button disabled={props.busy} onClick={() => props.onCreate?.()}>
                  Create a new folder
                </Button>
                <Button variant="primary" disabled={props.busy} onClick={() => props.onDefault?.()}>
                  Use ~/{DEFAULT_BASE}
                </Button>
              </div>
              <p class={styles.hint}>You can attach folders and move them into a space later.</p>
            </div>
          </>
        )}
      </Match>
      <Match when={props.pending?.plan ? { scan: props.pending.scan, plan: props.pending.plan } : null}>
        {(p) => (
          <>
            {chosen(p().scan.base)}
            <div class={styles.note}>
              {p().scan.misplaced.length} {p().scan.misplaced.length === 1 ? "project isn't" : "projects aren't"} in a
              space yet. Pick a space for each, or leave it where it is.
            </div>
            <GroupProjects scan={p().scan} plan={p().plan} onPlan={(plan) => props.onPlan?.(plan)} />
          </>
        )}
      </Match>
    </Switch>
  );
}
