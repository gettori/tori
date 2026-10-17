import Select, { type SelectOption } from "../../components/Select/Select";
import { executionLevel, setExecutionLevel, type ExecutionLevel } from "../Settings/settingsStore";
import { Row, Section } from "./Section";

const LEVELS: SelectOption[] = [
  { value: "asMe", label: "As me" },
  { value: "boxedWhenUnattended", label: "Boxed when unattended" },
  { value: "alwaysBoxed", label: "Always boxed" },
];

const HINT: Record<ExecutionLevel, string> = {
  asMe: "Agents run with your own access, whoever is watching.",
  boxedWhenUnattended:
    "A session started while nobody is at the window or the phone runs in the agent's own sandbox: no network past the allowed domains, no writes outside the project.",
  alwaysBoxed: "Every session runs in the agent's own sandbox, terminal tabs included.",
};

/** How this project's agents run. Whatever the level, a session nobody is
 *  watching cannot run the commands on the deny list in Settings. */
export default function ExecutionSection(props: { projectPath: string }) {
  const level = () => executionLevel(props.projectPath);
  return (
    <Section heading="Execution">
      <Row label="Sandbox" hint={HINT[level()]}>
        <Select
          options={LEVELS}
          value={level()}
          onChange={(v) => void setExecutionLevel(props.projectPath, v as ExecutionLevel)}
          aria-label="Sandbox"
        />
      </Row>
    </Section>
  );
}
