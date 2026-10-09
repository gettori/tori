import { provenanceLabel, type Contributor, type Provenance } from "../../../utils/packs";
import styles from "../Settings.module.css";

export default function ProvenanceTag(props: { provenance: Provenance; contributor: Contributor | null | undefined }) {
  return <span class={styles.kindTag}>{provenanceLabel(props.provenance, props.contributor)}</span>;
}
