import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { Settings2 } from "lucide-solid";

import Icon from "../../../components/Icon/Icon";
import OverlayScroll from "../../../components/Scrollbar/OverlayScroll";
import { createSpaceProject, projectUnitKind } from "../../../utils/topicMembers";
import {
  askedSection,
  SECTION_LABEL,
  sectionsFor,
  takeAskedSection,
  type ProjectSection,
} from "../../../utils/projectSettings";
import ProjectContractEditor from "../../Settings/panes/AutopilotPane/ProjectContractEditor";
import { settings } from "../../Settings/settingsStore";
import AgentsSection from "./AgentsSection";
import BranchesSection from "./BranchesSection";
import ChecksSection from "./ChecksSection";
import EditorSection from "./EditorSection";
import GeneralSection from "./GeneralSection";
import TrustSection from "./TrustSection";
import WorktreesSection from "./WorktreesSection";
import styles from "./ProjectSettingsView.module.css";

/**
 * Everything that is set per project, as one tab with a rail of sections.
 *
 * The record comes from config rather than from whoever opened the tab, so a
 * change made elsewhere (an icon set from another window, a rediscovery) shows
 * here without reopening it.
 */
export default function ProjectSettingsView(props: { workspace: string }) {
  const { found, loaded } = createSpaceProject(() => props.workspace);
  const kind = () => projectUnitKind(found()?.project);
  const sections = () => sectionsFor(kind(), settings.autopilot.available);

  const [picked, setPicked] = createSignal<ProjectSection>("general");
  // The strip reuses one component across tabs of a kind, so a new workspace
  // starts on General unless an entry point asked for a section.
  createEffect(
    on([() => props.workspace, askedSection], ([ws], prev) => {
      const asked = takeAskedSection(ws);
      if (asked) setPicked(asked);
      else if (!prev || prev[0] !== ws) setPicked("general");
    }),
  );
  // Held while the record loads, so a request for Worktrees is not lost to the
  // moment before the layout is known.
  const section = () => (sections().includes(picked()) ? picked() : "general");

  return (
    <div class={styles.page}>
      <div class={styles.topBar}>
        <Icon icon={Settings2} />
        <span class={styles.title}>Project settings</span>
        <span class={styles.name}>{found()?.project.name ?? ""}</span>
        <span class={styles.dir} title={props.workspace}>
          {props.workspace}
        </span>
      </div>

      <Show
        when={found()}
        fallback={
          <Show when={loaded()}>
            <p class={styles.missing}>Tori does not list a project at {props.workspace} right now.</p>
          </Show>
        }
      >
        {(f) => (
          <div class={styles.body}>
            <nav class={styles.rail} aria-label="Project settings sections">
              <For each={sections()}>
                {(s) => (
                  <button
                    type="button"
                    class={styles.railItem}
                    classList={{ [styles.railItemOn]: section() === s }}
                    aria-current={section() === s ? "page" : undefined}
                    onClick={() => setPicked(s)}
                  >
                    {SECTION_LABEL[s]}
                  </button>
                )}
              </For>
            </nav>

            <Switch>
              <Match when={section() === "worktrees"}>
                <WorktreesSection workspace={props.workspace} />
              </Match>
              <Match when={section() === "agents"}>
                <OverlayScroll class={styles.content}>
                  <AgentsSection project={f().project} />
                </OverlayScroll>
              </Match>
              <Match when={section() === "checks"}>
                <OverlayScroll class={styles.content}>
                  <ChecksSection projectPath={f().project.path} />
                </OverlayScroll>
              </Match>
              <Match when={section() === "trust"}>
                <OverlayScroll class={styles.content}>
                  <TrustSection projectPath={f().project.path} />
                </OverlayScroll>
              </Match>
              <Match when={section() === "branches"}>
                <OverlayScroll class={styles.content}>
                  <BranchesSection projectPath={f().project.path} projectName={f().project.name ?? f().project.path} />
                </OverlayScroll>
              </Match>
              <Match when={section() === "editor"}>
                <OverlayScroll class={styles.content}>
                  <EditorSection projectPath={f().project.path} kind={kind()} />
                </OverlayScroll>
              </Match>
              <Match when={section() === "autopilot"}>
                <OverlayScroll class={styles.content}>
                  <div class={styles.form}>
                    <ProjectContractEditor project={f().project.path} />
                  </div>
                </OverlayScroll>
              </Match>
              <Match when={section() === "general"}>
                <OverlayScroll class={styles.content}>
                  <GeneralSection project={f().project} space={f().space.name} kind={kind()} />
                </OverlayScroll>
              </Match>
            </Switch>
          </div>
        )}
      </Show>
    </div>
  );
}
