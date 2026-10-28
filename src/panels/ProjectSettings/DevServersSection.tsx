import { Show } from "solid-js";

import Button from "../../components/Button/Button";
import Switch from "../../components/Switch/Switch";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { repoValues, type Answered } from "../../utils/proposals";
import schema from "../../../src-tauri/resources/schemas/tori-project.schema.json";
import { Stepper } from "../Settings/components/paneKit";
import { portLinksOn, rememberWorktreePrefs, setPortLinks, worktreePrefs } from "../Settings/settingsStore";
import RepoValues from "./RepoValues";
import { Row, Section } from "./Section";

const BLOCK = schema.properties.ports.maximum;

/** Whether Tori looks for this project's dev servers and links them. Off by
 *  default: finding them runs `lsof`, which a project that serves nothing
 *  should not pay for. */
export default function DevServersSection(props: { projectPath: string; answered: Answered[] | undefined }) {
  const ports = () => worktreePrefs(props.projectPath).ports;
  const repo = () => repoValues(props.answered, "ports");
  // A stepper always shows a number, so unset shows the repo's width when every
  // accepted proposal agrees on one, rather than a default that is not in force.
  const shown = () => ports() ?? (repo().length === 1 ? repo()[0].value : BLOCK);
  const savePorts = (n: number | undefined) =>
    rememberWorktreePrefs(props.projectPath, { ports: n }).catch((e) =>
      emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }),
    );

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
      <Row
        label="Ports per worktree"
        hint={
          <>
            Each worktree holds a block of {BLOCK} ports, and this many of them are exported as <code>TORI_PORT</code>,{" "}
            <code>TORI_PORT_1</code> and on.
            <RepoValues values={repo()} overridden={ports() !== undefined} />
          </>
        }
      >
        <Show when={ports() !== undefined}>
          <Button size="sm" onClick={() => void savePorts(undefined)}>
            Reset
          </Button>
        </Show>
        <Stepper aria-label="Ports per worktree" min={1} max={BLOCK} value={shown()} onChange={savePorts} />
      </Row>
    </Section>
  );
}
