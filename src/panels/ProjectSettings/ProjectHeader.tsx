import { Copy } from "lucide-solid";

import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import ProjectIcon from "../../components/Icon/ProjectIcon";
import { copyText } from "../../utils/clipboard";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import type { SpaceProject } from "../../utils/topicMembers";
import s from "../Settings/Settings.module.css";
import { LAYOUT } from "./GeneralSection";
import styles from "./ProjectSettingsDialog.module.css";

/** The project's name where Settings has its title, at the title's size, so
 *  the two panels stand the same height. */
export function ProjectTitle(props: { project: SpaceProject }) {
  const name = () => props.project.name ?? props.project.path;
  return (
    <div class={`${s.title} ${styles.title}`}>
      <span class={styles.titleIcon}>
        <ProjectIcon
          seed={props.project.path}
          icon={props.project.icon}
          iconFile={props.project.iconFile}
          favicon={props.project.favicon}
        />
      </span>
      <span class={styles.titleName} title={name()}>
        {name()}
      </span>
    </div>
  );
}

/** Where these settings apply, in the card Settings uses to say where its own
 *  are written. */
export function ProjectFoot(props: { project: SpaceProject; space: string; kind: string | undefined }) {
  const copy = () =>
    void copyText(props.project.path).then((ok) =>
      emitWith<ToastEvent>(
        TOAST,
        ok ? { message: "Path copied." } : { message: "Could not copy the path.", kind: "error" },
      ),
    );

  return (
    <div class={s.railFoot}>
      <div class={styles.footHead}>
        <span class={s.railFootTitle}>This project</span>
        <IconButton size="xs" icon={<Icon icon={Copy} />} aria-label="Copy path" tooltip="Copy path" onClick={copy} />
      </div>
      <div class={s.railFootNote}>
        {props.space}, {(props.kind && LAYOUT[props.kind]?.toLowerCase()) ?? "unknown layout"}.
      </div>
      <div class={`${s.railFootNote} ${styles.footPath}`}>
        <code>{props.project.path}</code>
      </div>
    </div>
  );
}
