import AgentsSection from "./AgentsSection";
import { CardSection, type PaneProps } from "../../components/paneKit";

/**
 * The agents Sway found. Nothing but the table: each agent's path, version and
 * override live on its own page, where there is room to explain them. The
 * global binary-path row that used to sit below is gone with the catalogue
 * entry that named it; `settings.agent.path` itself still works for a
 * hand-edited settings file.
 */
export default function AgentsPane(props: PaneProps) {
  return (
    <CardSection {...props} id="agents">
      <AgentsSection />
    </CardSection>
  );
}
