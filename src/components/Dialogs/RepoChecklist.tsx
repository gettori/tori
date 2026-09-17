import { For, createMemo, type JSX } from "solid-js";
import CheckboxGroup from "../CheckboxGroup/CheckboxGroup";
import styles from "./Dialogs.module.css";

/** The slice of a Space the checklist needs: its name for the group label,
 *  whether it is a pinned "Other" Space (listed after the root ones, as the
 *  sidebar rail does), and the projects to offer. */
export type RepoSpace = {
  name: string;
  external: boolean;
  projects: { name: string; path: string }[];
};

/** One checkbox group per Space, root Spaces first and pinned ones after,
 *  reporting the checked repo paths in rail order regardless of click order.
 *  `exclude` drops repos that cannot be picked (a Topic's current members);
 *  `collision` hangs an element under a repo's row, which is where the
 *  creation dialog puts its "already exists" line. */
export default function RepoChecklist(props: {
  spaces: RepoSpace[];
  value: string[];
  onChange: (paths: string[]) => void;
  exclude?: string[];
  collision?: (repoPath: string) => JSX.Element | undefined;
}) {
  const ordered = () => {
    const excluded = new Set(props.exclude ?? []);
    return [...props.spaces.filter((g) => !g.external), ...props.spaces.filter((g) => g.external)]
      .map((g) => ({ ...g, projects: g.projects.filter((p) => !excluded.has(p.path)) }))
      .filter((g) => g.projects.length > 0);
  };

  const allPaths = () => ordered().flatMap((g) => g.projects.map((p) => p.path));

  function changeGroup(group: RepoSpace, picked: string[]) {
    const own = new Set(group.projects.map((p) => p.path));
    const kept = new Set([...props.value.filter((v) => !own.has(v)), ...picked]);
    props.onChange(allPaths().filter((p) => kept.has(p)));
  }

  // Built once per Space set, not per collision change: a fresh options array
  // would remount every checkbox row (and drop keyboard focus) each time a
  // probe lands. The collision slot is a component, so only it re-renders.
  const Collision = (slot: { path: string }) => <>{props.collision?.(slot.path)}</>;
  const groups = createMemo(() =>
    ordered().map((g) => ({
      space: g,
      options: g.projects.map((p) => ({
        value: p.path,
        label: p.name,
        description: props.collision ? <Collision path={p.path} /> : undefined,
      })),
    })),
  );

  return (
    <div class={styles.repoChecklist} data-repo-checklist>
      <For each={groups()}>
        {({ space, options }) => (
          <CheckboxGroup
            label={space.name}
            options={options}
            value={props.value.filter((v) => space.projects.some((p) => p.path === v))}
            onChange={(picked) => changeGroup(space, picked)}
          />
        )}
      </For>
    </div>
  );
}
