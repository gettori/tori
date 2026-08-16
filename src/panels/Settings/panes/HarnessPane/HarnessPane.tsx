import HarnessSection from "./HarnessSection";
import { CardSection, Group, Row, idsIn, setHarness, type PaneProps } from "../../components/paneKit";
import { settings } from "../../settingsStore";
import styles from "../../Settings.module.css";

/**
 * The harnesses Sway found, and the binary override that points past discovery.
 *
 * The override joins the cards rather than getting a tab of its own because it
 * is the same subject read from the other end: the cards say which binary was
 * found, this says to use a different one. Its own hint already sent the reader
 * here.
 */
export default function HarnessPane(props: PaneProps) {
  return (
    <>
      <CardSection {...props} id="agents">
        <HarnessSection />
      </CardSection>

      <Group {...props} title="Harness" ids={idsIn("harness")}>
        <Row
          {...props}
          id="harness-path"
          label="Binary path"
          hint="Overrides the discovered binary for new chat sessions. Leave it empty to use the one found above. The detected version and any drift from what Sway's adapter was built against are shown on the cards above."
        >
          <input
            class={`${styles.input} ${styles.text}`}
            value={settings.harness.path ?? ""}
            placeholder="found on your login shell's PATH"
            onChange={(e) => setHarness({ path: e.currentTarget.value.trim() || null })}
          />
        </Row>
      </Group>
    </>
  );
}
