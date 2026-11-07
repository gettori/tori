import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, ListX, ShieldCheck, ShieldOff } from "lucide-solid";

import ConfirmDialog from "../../../../components/Dialogs/ConfirmDialog";
import Icon from "../../../../components/Icon/Icon";
import IconButton from "../../../../components/IconButton/IconButton";
import ProjectIcon from "../../../../components/Icon/ProjectIcon";
import { emitWith, TOAST, type ToastEvent } from "../../../../utils/events";
import { GLOBAL_KEY, GLOBAL_NAME } from "../../../../utils/globalSpace";
import { isUnderPath, sameCwd } from "../../../../utils/pathScope";
import { openProjectSettings } from "../../../../utils/projectSettings";
import { onTrustChange, refusedProjects, revokeProject, trustProject } from "../../../../utils/projectTrust";
import { createSpaces } from "../../../../utils/topicMembers";
import styles from "../../Settings.module.css";
import own from "./ProjectList.module.css";

type Filter = "all" | "trusted" | "untrusted";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "trusted", label: "Trusted" },
  { id: "untrusted", label: "Not trusted" },
];

/**
 * Every project Tori found, with its trust and the way into its settings, then
 * the trusted or refused paths that match no project: a parent folder trusted
 * whole, or a project since removed. Trust is stored by path and covers what is
 * under it, so a project trusted through a parent says so and cannot be revoked
 * on its own.
 */
export default function ProjectTrust() {
  const spaces = createSpaces();
  const [trusted, { refetch: refetchTrusted }] = createResource(() =>
    invoke<string[]>("trusted_projects").catch(() => [] as string[]),
  );
  const [discovered, { refetch: refetchDiscovered }] = createResource(() =>
    invoke<string[] | null>("untrusted_projects").catch(() => null),
  );
  onCleanup(
    onTrustChange(() => {
      void refetchTrusted();
      void refetchDiscovered();
    }),
  );
  const [filter, setFilter] = createSignal<Filter>("all");
  const [query, setQuery] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);

  const entries = () => (trusted() ?? []).filter(Boolean);
  const projects = () =>
    (spaces() ?? []).flatMap((space) =>
      space.projects.map((project) => {
        const exact = entries().find((t) => sameCwd(t, project.path)) ?? null;
        const via = exact ? null : (entries().find((t) => isUnderPath(project.path, t)) ?? null);
        return {
          project,
          space: space.name === GLOBAL_KEY ? GLOBAL_NAME : space.name,
          name: project.name ?? project.path,
          exact,
          via,
          trusted: !!exact || !!via,
        };
      }),
    );
  const isProject = (path: string) => projects().some((r) => sameCwd(r.project.path, path));
  const others = () => {
    const refused = [...new Set([...(discovered() ?? []), ...refusedProjects()])].filter((p) => !isProject(p));
    return [
      ...entries()
        .filter((p) => !isProject(p))
        .sort()
        .map((path) => ({ path, trusted: true })),
      ...refused.sort().map((path) => ({ path, trusted: false })),
    ];
  };

  const count = (f: Filter) => projects().filter((r) => f === "all" || r.trusted === (f === "trusted")).length;
  const q = () => query().trim().toLowerCase();
  const matches = (...text: string[]) => !q() || text.some((t) => t.toLowerCase().includes(q()));
  const shown = () =>
    projects().filter(
      (r) => (filter() === "all" || r.trusted === (filter() === "trusted")) && matches(r.name, r.space, r.project.path),
    );
  // In the order the spaces come, each space once, for its heading.
  const bySpace = () =>
    shown().reduce<{ space: string; rows: ReturnType<typeof shown> }[]>((groups, r) => {
      const last = groups[groups.length - 1];
      if (last?.space === r.space) last.rows.push(r);
      else groups.push({ space: r.space, rows: [r] });
      return groups;
    }, []);
  const shownOthers = () => others().filter((o) => matches(o.path));

  // Trust on what is not trusted, untrust on what holds its own entry, and for
  // what a parent folder covers, a disabled mark that names the folder.
  const trustButton = (name: string, path: string, exact: string | null, via: string | null) =>
    exact ? (
      <IconButton
        size="xs"
        icon={<Icon icon={ShieldOff} />}
        tooltip="Untrust"
        aria-label={`Untrust ${name}`}
        onClick={() => run("untrust", revokeProject(exact))}
      />
    ) : via ? (
      <IconButton
        size="xs"
        disabled
        tooltipWhenDisabled
        icon={<Icon icon={ShieldCheck} />}
        tooltip={`Trusted via ${via}`}
        aria-label={`${name} is trusted via ${via}`}
      />
    ) : (
      <IconButton
        size="xs"
        icon={<Icon icon={ShieldCheck} />}
        tooltip="Trust"
        aria-label={`Trust ${name}`}
        onClick={() => run("trust", trustProject(path))}
      />
    );

  const run = (verb: string, change: Promise<unknown>) =>
    void change.catch((e) => emitWith<ToastEvent>(TOAST, { message: `Could not ${verb} this project: ${String(e)}` }));
  const revokeAll = () => {
    setConfirming(false);
    run("revoke", Promise.all(entries().map(revokeProject)));
  };

  return (
    <section class={styles.section}>
      <div class={styles.sectionTitle}>
        <span>Projects</span>
        <span class={styles.sectionRule} />
        <div class={styles.groupTabs} role="group" aria-label="Show projects">
          <For each={FILTERS}>
            {(f) => (
              <button
                type="button"
                class={styles.groupTab}
                aria-pressed={filter() === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                <span class={styles.groupTabCount}>{count(f.id)}</span>
              </button>
            )}
          </For>
        </div>
        <input
          type="text"
          class={styles.tableFilter}
          placeholder="Search"
          aria-label="Search projects"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show when={entries().length > 0}>
          <IconButton size="sm" icon={<Icon icon={ListX} />} tooltip="Revoke all" onClick={() => setConfirming(true)} />
        </Show>
      </div>

      <Show when={spaces()}>
        <Show
          when={shown().length > 0}
          fallback={
            <div class={styles.note}>
              {q()
                ? `No project matches "${query().trim()}".`
                : projects().length === 0
                  ? "No projects yet."
                  : filter() === "trusted"
                    ? "No trusted projects."
                    : "Every project is trusted."}
            </div>
          }
        >
          <For each={bySpace()}>
            {(group) => (
              <>
                <div class={own.spaceHead}>{group.space}</div>
                <div class={own.list}>
                  <For each={group.rows}>
                    {(r) => (
                      <div class={own.item}>
                        <button
                          type="button"
                          class={own.row}
                          aria-label={`Open settings for ${r.name}`}
                          onClick={() => openProjectSettings(r.project.path)}
                        >
                          <span class={own.icon}>
                            <ProjectIcon
                              seed={r.project.path}
                              icon={r.project.icon}
                              iconFile={r.project.iconFile}
                              favicon={r.project.favicon}
                            />
                          </span>
                          <span class={own.name}>{r.name}</span>
                          <Icon icon={ChevronRight} aria-hidden="true" />
                        </button>
                        <span class={own.action}>{trustButton(r.name, r.project.path, r.exact, r.via)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </Show>
      </Show>

      <Show when={shownOthers().length > 0}>
        <div class={own.othersTitle}>Other paths</div>
        <div class={own.list}>
          <For each={shownOthers()}>
            {(o) => (
              <div class={`${own.item} ${own.pathItem}`}>
                <code class={own.path} classList={{ [own.pathOff]: !o.trusted }} title={o.path}>
                  {o.path}
                </code>
                <span class={own.action}>{trustButton(o.path, o.path, o.trusted ? o.path : null, null)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class={styles.note}>
        Each project opens its own settings. Servers that run a project's own code, like TypeScript and Rust, and every
        debugger only start in trusted projects.
      </div>

      <Show when={confirming()}>
        <ConfirmDialog
          danger
          title="Revoke every trusted project?"
          message={`Servers that run a project's own code stop in all ${entries().length}, until you trust each one again here.`}
          confirmLabel="Revoke all"
          onConfirm={revokeAll}
          onCancel={() => setConfirming(false)}
        />
      </Show>
    </section>
  );
}
