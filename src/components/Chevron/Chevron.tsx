import { ChevronRight } from "lucide-solid";
import Icon from "../Icon/Icon";
import styles from "./Chevron.module.css";

/** Rotating disclosure chevron, shared by the editor file tree and the left
 *  sidebar so both expand/collapse affordances look identical. A Lucide
 *  chevron-right in a 16px slot; the inner span rotates 90° on open, pivoting on
 *  the icon itself so it stays in place. */
export default function Chevron(props: { open: boolean; class?: string }) {
  return (
    <span class={styles.chevron} classList={{ [props.class ?? ""]: !!props.class }}>
      <span class={styles.chev} classList={{ [styles.open]: props.open }}>
        <Icon icon={ChevronRight} />
      </span>
    </span>
  );
}
