import GitSection from "./GitSection";
import ForgeSection from "./ForgeSection";
import Select, { type SelectOption } from "../../../../components/Select/Select";
import { settings, setFetchEveryMinutes } from "../../settingsStore";
import { CardSection, Group, Row, rowLabelId, type PaneProps } from "../../components/paneKit";

/** How often the background fetch runs. Off is first, because it is the answer
 *  someone comes to this row to give: the other five differ only in patience. */
const FETCH_OPTIONS: SelectOption[] = [
  { value: "0", label: "Off" },
  { value: "2", label: "2 minutes" },
  { value: "5", label: "5 minutes" },
  { value: "10", label: "10 minutes" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
];

/** Git itself, what Tori does with remotes, then the forge accounts and their
 *  kill switch. */
export default function IntegrationsPane(props: PaneProps) {
  return (
    <>
      <CardSection {...props} id="git">
        <GitSection />
      </CardSection>
      <Group {...props} title="Remote" ids={["fetch-every"]}>
        <Row {...props} id="fetch-every" label="Fetch every">
          <Select
            options={FETCH_OPTIONS}
            value={String(settings.git.fetchEveryMinutes)}
            onChange={(v) => setFetchEveryMinutes(Number(v))}
            aria-labelledby={rowLabelId("fetch-every")}
          />
        </Row>
      </Group>
      <CardSection {...props} id="forge">
        <ForgeSection />
      </CardSection>
    </>
  );
}
