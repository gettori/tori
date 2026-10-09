import { Show } from "solid-js";
import { provenanceLabel, type Contributor, type Provenance } from "../../../utils/packs";
import styles from "../Settings.module.css";

export default function ProvenanceTag(props: { provenance: Provenance; contributor: Contributor | null | undefined }) {
  return <span class={styles.kindTag}>{provenanceLabel(props.provenance, props.contributor)}</span>;
}

export function CatalogConflict(props: { provenance: Provenance; id: string }) {
  return (
    <Show when={props.provenance.catalogConflict}>
      <div class={styles.toolMeta}>
        The catalog also has a pack called <code>{props.id}</code>. Rename yours to install it.
      </div>
    </Show>
  );
}
