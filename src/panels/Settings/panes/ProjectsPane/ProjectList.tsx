import { For, Show } from "solid-js";
import { ChevronRight } from "lucide-solid";

import Icon from "../../../../components/Icon/Icon";
import ProjectIcon from "../../../../components/Icon/ProjectIcon";
import { GLOBAL_KEY, GLOBAL_NAME } from "../../../../utils/globalSpace";
import { openProjectSettings, type ProjectSection } from "../../../../utils/projectSettings";
import { createSpaces } from "../../../../utils/topicMembers";
import styles from "../../Settings.module.css";
import own from "./ProjectList.module.css";

/**
 * Every project Tori found, each a door to its own settings dialog. Settings holds
 * no project setting of its own: it is one more way in, so a row opens the dialog
 * (on `section` when named) over this panel, which is here again when it closes.
 */
export default function ProjectList(props: { section?: ProjectSection }) {
  const spaces = createSpaces();

  const rows = () =>
    (spaces() ?? []).flatMap((space) =>
      space.projects.map((project) => ({
        space: space.name === GLOBAL_KEY ? GLOBAL_NAME : space.name,
        project,
        name: project.name ?? project.path,
      })),
    );

  return (
    <Show when={spaces()}>
      <Show when={rows().length} fallback={<div class={styles.note}>No projects yet.</div>}>
        <div class={own.list}>
          <For each={rows()}>
            {(r) => (
              <button
                type="button"
                class={own.row}
                aria-label={`Open settings for ${r.name}`}
                onClick={() => openProjectSettings(r.project.path, props.section)}
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
                <span class={own.space}>{r.space}</span>
                <Icon icon={ChevronRight} aria-hidden="true" />
              </button>
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}
