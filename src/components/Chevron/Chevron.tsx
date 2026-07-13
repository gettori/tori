import styles from "./Chevron.module.css";

/** Rotating disclosure chevron, shared by the editor file tree and the left
 *  sidebar so both expand/collapse affordances look identical. A single `›`
 *  glyph in a 16px slot; the inner span rotates 90° on open, pivoting on the
 *  glyph itself so it stays in place. */
export default function Chevron(props: { open: boolean }) {
  return (
    <span class={styles.chevron}>
      <span class={styles.chev} classList={{ [styles.open]: props.open }}>
        ›
      </span>
    </span>
  );
}
