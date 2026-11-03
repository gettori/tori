import { Folder } from "lucide-solid";
import Icon from "../Icon/Icon";
import styles from "./Dialogs.module.css";

/** The tag is words as well as colour, so Remove and Detach never read alike. */
export default function PathBox(props: { path: string; detail: string; fate: "deleted" | "stays" }) {
  return (
    <div class={styles.pathBox} classList={{ [styles.pathBoxDeleted]: props.fate === "deleted" }}>
      <Icon icon={Folder} class={styles.pathBoxIcon} />
      <span class={styles.pathBoxText}>
        <span class={styles.pathBoxPath}>{props.path}</span>
        <span class={styles.pathBoxDetail}>{props.detail}</span>
      </span>
      <span class={styles.pathBoxTag}>{props.fate === "deleted" ? "Deleted" : "Stays on disk"}</span>
    </div>
  );
}
