import Switch from "../../components/Switch/Switch";
import { portLinksOn, setPortLinks } from "../Settings/settingsStore";
import { Row, Section } from "./Section";

/** Whether Tori looks for this project's dev servers and links them. Off by
 *  default: finding them runs `lsof`, which a project that serves nothing
 *  should not pay for. */
export default function DevServersSection(props: { projectPath: string }) {
  return (
    <Section heading="Dev servers">
      <Row
        label="Show dev server links"
        hint="A server listening from this project or one of its worktrees shows as a link on its row and in Scripts, on whatever port it picked."
      >
        <Switch
          checked={portLinksOn(props.projectPath)}
          onChange={(on) => void setPortLinks(props.projectPath, on)}
          aria-label="Show dev server links"
        />
      </Row>
    </Section>
  );
}
