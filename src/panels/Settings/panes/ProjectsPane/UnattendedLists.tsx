import { createResource, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../../../../components/Button/Button";
import { Group, Row, rowLabelId, type PaneProps } from "../../components/paneKit";
import { setUnattended, settings, type Unattended } from "../../settingsStore";
import styles from "../../Settings.module.css";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function ListRow(props: PaneProps & { id: string; label: string; key: keyof Unattended; defaults?: string[] }) {
  const list = () => settings.unattended?.[props.key] ?? props.defaults ?? [];
  const edited = () => (settings.unattended?.[props.key] ?? null) !== null;
  return (
    <Row {...props} stack>
      <textarea
        class={styles.listField}
        aria-labelledby={rowLabelId(props.id)}
        rows={6}
        spellcheck={false}
        value={list().join("\n")}
        onChange={(e) => void setUnattended({ [props.key]: lines(e.currentTarget.value) })}
      />
      <Show when={edited()}>
        <Button onClick={() => void setUnattended({ [props.key]: null })}>Reset to defaults</Button>
      </Show>
    </Row>
  );
}

/** What a session nobody is watching may not run, and where a boxed session may
 *  reach. One list for every project; the level is set per project. */
export default function UnattendedLists(props: PaneProps) {
  const [defaults] = createResource(() => invoke<Unattended>("unattended_defaults"));
  return (
    <Group {...props} title="Unattended sessions" ids={["unattended-deny", "unattended-domains"]}>
      <ListRow
        {...props}
        id="unattended-deny"
        label="Never run unattended"
        key="deny"
        defaults={defaults()?.deny ?? []}
      />
      <ListRow
        {...props}
        id="unattended-domains"
        label="Allowed domains when boxed"
        key="allowedDomains"
        defaults={defaults()?.allowedDomains ?? []}
      />
    </Group>
  );
}
