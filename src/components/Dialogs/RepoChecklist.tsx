import { For, Show, createMemo } from "solid-js";
import CheckboxGroup from "../CheckboxGroup/CheckboxGroup";
import styles from "./Dialogs.module.css";
import { spaceLabel } from "../../utils/globalSpace";

/** The slice of a Space the checklist needs: its name for the group label and
 *  the projects to offer. */
export type RepoSpace = {
  name: string;
  icon?: string;
  color?: string;
  projects: {
    name: string;
    path: string;
    availability?: "ok" | "missing";
    branchUnits?: { branch: string | null; isCurrent: boolean }[];
  }[];
};

const checkedOut = (p: RepoSpace["projects"][number]) => p.branchUnits?.find((u) => u.isCurrent)?.branch ?? null;

/** One checkbox group per Space, in rail order, reporting the checked repo
 *  paths in that order regardless of click order.
 *  `exclude` drops repos that cannot be picked (a Topic's current members);
 *  `filter` hides repos whose name does not contain it, without unchecking them. */
export default function RepoChecklist(props: {
  spaces: RepoSpace[];
  value: string[];
  onChange: (paths: string[]) => void;
  exclude?: string[];
  filter?: string;
  /** One space's projects only: the group reads `Projects in <space>` with how
   *  many are picked, and each row names the branch a worktree starts from. */
  scoped?: boolean;
}) {
  const ordered = () => {
    const excluded = new Set(props.exclude ?? []);
    return props.spaces
      .map((g) => ({
        ...g,
        projects: g.projects.filter((p) => !excluded.has(p.path) && p.availability !== "missing"),
      }))
      .filter((g) => g.projects.length > 0);
  };

  const allPaths = () => ordered().flatMap((g) => g.projects.map((p) => p.path));
  const shown = () => {
    const q = (props.filter ?? "").trim().toLowerCase();
    if (!q) return ordered();
    return ordered()
      .map((g) => ({ ...g, projects: g.projects.filter((p) => p.name.toLowerCase().includes(q)) }))
      .filter((g) => g.projects.length > 0);
  };

  function changeGroup(group: RepoSpace, picked: string[]) {
    const own = new Set(group.projects.map((p) => p.path));
    const kept = new Set([...props.value.filter((v) => !own.has(v)), ...picked]);
    props.onChange(allPaths().filter((p) => kept.has(p)));
  }

  const groups = createMemo(() =>
    shown().map((g) => ({
      space: g,
      options: g.projects.map((p) => {
        const from = props.scoped ? checkedOut(p) : null;
        return { value: p.path, label: p.name, description: from ? `from ${from}` : undefined };
      }),
    })),
  );
  const unfilteredProjects = (g: RepoSpace) => ordered().find((o) => o.name === g.name)?.projects ?? [];
  const total = (g: RepoSpace) => unfilteredProjects(g).length;
  const pickedIn = (g: RepoSpace) => props.value.filter((v) => unfilteredProjects(g).some((p) => p.path === v)).length;

  return (
    <div class={styles.repoChecklist} data-repo-checklist>
      <For each={groups()}>
        {({ space, options }) => (
          <CheckboxGroup
            label={
              <Show when={props.scoped} fallback={<span class={styles.repoGroupLabel}>{spaceLabel(space.name)}</span>}>
                <span class={styles.repoGroupLabel}>Projects in {spaceLabel(space.name)}</span>{" "}
                <span class={styles.repoGroupCount}>
                  {pickedIn(space)} of {total(space)}
                </span>
              </Show>
            }
            options={options}
            value={props.value.filter((v) => space.projects.some((p) => p.path === v))}
            onChange={(picked) => changeGroup(space, picked)}
          />
        )}
      </For>
      <Show when={groups().length === 0}>
        <div class={styles.pickedEmpty}>No repositories match.</div>
      </Show>
    </div>
  );
}
