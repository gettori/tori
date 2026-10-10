import { Copy } from "lucide-solid";

import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import ProjectIcon from "../../components/Icon/ProjectIcon";
import { copyText } from "../../utils/clipboard";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import type { SpaceProject } from "../../utils/topicMembers";
import { LAYOUT } from "./GeneralSection";
import styles from "./ProjectSettingsDialog.module.css";

const PATH_KEEP = 64;

/** The path cut in the middle, so both the root it hangs off and the folder it
 *  names stay readable: the head keeps two fifths, the tail the rest. */
export function middleCut(path: string, keep = PATH_KEEP): string {
  if (path.length <= keep) return path;
  const head = Math.floor(keep * 0.4);
  return `${path.slice(0, head)}...${path.slice(path.length - (keep - head))}`;
}

/** Which project the dialog is for, in the place Settings puts its title. */
export default function ProjectHeader(props: { project: SpaceProject; space: string; kind: string | undefined }) {
  const copy = () =>
    void copyText(props.project.path).then((ok) =>
      emitWith<ToastEvent>(
        TOAST,
        ok ? { message: "Path copied." } : { message: "Could not copy the path.", kind: "error" },
      ),
    );

  return (
    <div class={styles.identity}>
      <span class={styles.identityTile}>
        <ProjectIcon
          seed={props.project.path}
          icon={props.project.icon}
          iconFile={props.project.iconFile}
          favicon={props.project.favicon}
        />
      </span>
      <span class={styles.identityText}>
        <span class={styles.identityName}>{props.project.name ?? props.project.path}</span>
        <span class={styles.identityMeta}>
          <span class={styles.spaceChip}>{props.space}</span>
          <span>{(props.kind && LAYOUT[props.kind]) ?? "Unknown layout"}</span>
          <span class={styles.metaDot} aria-hidden="true" />
          <span class={styles.identityPath} title={props.project.path}>
            {middleCut(props.project.path)}
          </span>
        </span>
      </span>
      <IconButton
        size="sm"
        class={styles.copyPath}
        icon={<Icon icon={Copy} />}
        aria-label="Copy path"
        tooltip="Copy path"
        onClick={copy}
      />
    </div>
  );
}
