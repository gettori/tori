import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Bot, FolderSymlink, SlidersHorizontal, Wrench, X, type LucideIcon } from "lucide-solid";

import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import { onWith, OPEN_SETTINGS } from "../../utils/events";
import { markProjectShown, SECTION_LABEL, sectionsFor, type ProjectSection } from "../../utils/projectSettings";
import { projectUntrusted } from "../../utils/projectTrust";
import { createSpaceProject, projectUnitKind } from "../../utils/topicMembers";
import ModalShell from "../Settings/components/ModalShell";
import s from "../Settings/Settings.module.css";
import AgentsSection from "./AgentsSection";
import ChecksSection from "./ChecksSection";
import EditorSection from "./EditorSection";
import GeneralSection from "./GeneralSection";
import { ProjectFoot, ProjectTitle } from "./ProjectHeader";
import { ProjectSearch } from "./Section";
import TrustSection from "./TrustSection";
import WorktreesSection from "./WorktreesSection";
import styles from "./ProjectSettingsDialog.module.css";

const SECTION_ICON: Record<ProjectSection, LucideIcon> = {
  general: SlidersHorizontal,
  worktrees: FolderSymlink,
  agents: Bot,
  tooling: Wrench,
};

const tabId = (id: ProjectSection) => `project-tab-${id}`;
const paneId = (id: ProjectSection) => `project-pane-${id}`;

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * Everything that is set per project, as a dialog in Settings' own panel with
 * a rail of sections.
 *
 * The record comes from config rather than from whoever opened the dialog, so
 * a change made elsewhere (an icon set from another window, a rediscovery)
 * shows here without reopening it.
 */
export default function ProjectSettingsDialog(props: { path: string; section?: ProjectSection; onClose: () => void }) {
  let railEl!: HTMLDivElement;
  let searchEl: HTMLInputElement | undefined;
  const { found, loaded } = createSpaceProject(() => props.path);
  const kind = () => projectUnitKind(found()?.project);
  const sections = () => sectionsFor(kind());
  const name = () => found()?.project.name ?? basename(props.path);

  const [picked, setPicked] = createSignal<ProjectSection>(props.section ?? "general");
  // Held while the record loads, so a request for Worktrees is not lost to the
  // moment before the layout is known. Once it is known, a section this project
  // does not have is dropped, so it cannot surface later when one appears.
  createEffect(() => {
    if (found() && !sections().includes(picked())) setPicked("general");
  });
  const section = () => (sections().includes(picked()) ? picked() : "general");

  // The rail's search, as Settings' is: every pane opens on its matches and
  // the rail selects nothing until the box is cleared or a section is picked.
  const [query, setQuery] = createSignal("");
  const q = () => query().trim().toLowerCase();
  const searching = () => q() !== "";
  const paneMatches: Partial<Record<ProjectSection, () => boolean>> = {};
  const nothingMatched = () => searching() && sections().every((id) => !paneMatches[id]?.());
  const openSection = (id: ProjectSection) => {
    setPicked(id);
    setQuery("");
  };
  const clearQuery = () => {
    if (query() === "") return false;
    setQuery("");
    return true;
  };
  onMount(() => requestAnimationFrame(() => searchEl?.focus()));

  onCleanup(markProjectShown(props.path));
  // The doors out of here (the trusted list, the hosts) lead into Settings,
  // which sits under this dialog, so this one gets out of the way.
  onCleanup(onWith(OPEN_SETTINGS, () => props.onClose()));

  // Which drafts are unsaved, by "<section>:<list>". A section's rail item
  // carries a dot while any of its lists has one.
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});
  const markDirty = (key: string, on: boolean) => setDirty((now) => (!!now[key] === on ? now : { ...now, [key]: on }));
  const sectionDirty = (id: ProjectSection) =>
    Object.entries(dirty()).some(([key, on]) => on && key.startsWith(`${id}:`));

  /** Arrow, Home and End across the rail, wrapping, as Settings' rail does. */
  function onRailKeyDown(e: KeyboardEvent) {
    const all = sections();
    const n = all.length;
    const current = all.indexOf(section());
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (current + 1) % n
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (current - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : current;
    if (next === current) return;
    e.preventDefault();
    openSection(all[next]);
    railEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  // Every section stays mounted and the inactive ones are hidden, so a draft
  // survives a look at another section; the rail's dot is only honest if so.
  // `body` is a thunk so the sections are built inside the search's provider.
  const pane = (id: ProjectSection, body: () => JSX.Element) => {
    let el: HTMLDivElement | undefined;
    const paneHit = () => searching() && SECTION_LABEL[id].toLowerCase().includes(q());
    const matches = () => paneHit() || !!el?.textContent?.toLowerCase().includes(q());
    paneMatches[id] = matches;
    return (
      <Show when={sections().includes(id)}>
        <Show when={searching() && matches()}>
          <div class={s.resultCount}>{SECTION_LABEL[id]}</div>
        </Show>
        <div
          ref={el}
          id={paneId(id)}
          data-pane={id}
          role={searching() ? "group" : "tabpanel"}
          aria-label={searching() ? SECTION_LABEL[id] : undefined}
          aria-labelledby={searching() ? undefined : tabId(id)}
          hidden={searching() ? !matches() : section() !== id}
        >
          <ProjectSearch.Provider value={{ query: q, paneHit }}>{body()}</ProjectSearch.Provider>
        </div>
      </Show>
    );
  };

  return (
    <ModalShell label={`${name()} settings`} onClose={props.onClose} onEscape={clearQuery}>
      <div class={s.header}>
        <Show when={found()} fallback={<div class={s.title}>Project settings</div>}>
          {(f) => <ProjectTitle project={f().project} />}
        </Show>
        <div class={s.headerActions}>
          <IconButton
            icon={<Icon icon={X} />}
            size="sm"
            aria-label="Close"
            tooltip="Close"
            onClick={() => props.onClose()}
          />
        </div>
      </div>

      <Show
        when={found()}
        fallback={
          <Show when={loaded()}>
            <p class={styles.missing}>Tori does not list a project at {props.path} right now.</p>
          </Show>
        }
      >
        {(f) => (
          <div class={s.body}>
            <div class={s.railCol}>
              <div class={s.railSearch}>
                <input
                  ref={searchEl}
                  class={s.searchInput}
                  type="search"
                  aria-label="Search project settings"
                  placeholder="Search project settings"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
              </div>
              <OverlayScroll class={s.railScroll}>
                <div class={s.railGroup}>Project</div>
                <div
                  ref={railEl}
                  class={s.rail}
                  role="tablist"
                  aria-orientation="vertical"
                  aria-label="Project settings sections"
                  onKeyDown={onRailKeyDown}
                >
                  <For each={sections()}>
                    {(id) => {
                      const selected = () => !searching() && section() === id;
                      const warn = () => id === "tooling" && projectUntrusted(f().project.path);
                      const label = () =>
                        [SECTION_LABEL[id], warn() ? "not trusted" : null, sectionDirty(id) ? "unsaved changes" : null]
                          .filter(Boolean)
                          .join(", ");
                      return (
                        <button
                          type="button"
                          role="tab"
                          id={tabId(id)}
                          class={s.railItem}
                          classList={{ [s.railItemActive]: selected() }}
                          aria-controls={selected() ? paneId(id) : undefined}
                          aria-selected={selected()}
                          aria-label={label()}
                          tabindex={section() === id ? 0 : -1}
                          onClick={() => openSection(id)}
                        >
                          <Icon icon={SECTION_ICON[id]} />
                          <span class={s.railLabel}>{SECTION_LABEL[id]}</span>
                          <Show when={sectionDirty(id)}>
                            <span class={`${s.dot} ${styles.dotUnsaved}`} aria-hidden="true" />
                          </Show>
                          <Show when={warn()}>
                            <span class={`${s.dot} ${s.dotWarn}`} aria-hidden="true" />
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </OverlayScroll>
              <ProjectFoot project={f().project} space={f().space.name} kind={kind()} />
            </div>

            <OverlayScroll class={s.pane} contentClass={s.paneInner}>
              <Show when={nothingMatched()}>
                <div class={s.note}>No setting matches "{query().trim()}".</div>
              </Show>
              {pane("general", () => (
                <GeneralSection project={f().project} kind={kind()} />
              ))}
              {pane("worktrees", () => (
                <WorktreesSection workspace={f().project.path} />
              ))}
              {pane("agents", () => (
                <AgentsSection project={f().project} onDirty={(key, on) => markDirty(`agents:${key}`, on)} />
              ))}
              {pane("tooling", () => (
                <>
                  <TrustSection projectPath={f().project.path} />
                  <ChecksSection projectPath={f().project.path} onDirty={(on) => markDirty("tooling:checks", on)} />
                  <Show when={kind() === "plain" || kind() === "plain-dir"}>
                    <EditorSection projectPath={f().project.path} />
                  </Show>
                </>
              ))}
            </OverlayScroll>
          </div>
        )}
      </Show>
    </ModalShell>
  );
}
