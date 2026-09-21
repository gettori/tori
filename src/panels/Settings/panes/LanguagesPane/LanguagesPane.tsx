import LspSection from "./LspSection";
import DapSection from "./DapSection";
import LintersSection from "./LintersSection";
import FormattersSection from "./FormattersSection";
import TrustedProjects from "./TrustedProjects";
import { CardSection, type PaneProps } from "../../components/paneKit";

/**
 * The Languages group's panes, one section each.
 *
 * Every section's rows only exist at runtime, one per thing installed or
 * trusted, so each carries a single catalogue entry standing for the whole
 * section and is shown, hidden and marked whole. There is nothing here to
 * filter row by row.
 */
export function ServersPane(props: PaneProps) {
  return (
    <CardSection {...props} id="language-servers">
      <LspSection />
    </CardSection>
  );
}

export function DebuggersPane(props: PaneProps) {
  return (
    <CardSection {...props} id="debuggers">
      <DapSection />
    </CardSection>
  );
}

export function LintersPane(props: PaneProps) {
  return (
    <CardSection {...props} id="linters">
      <LintersSection />
    </CardSection>
  );
}

export function FormattersPane(props: PaneProps) {
  return (
    <CardSection {...props} id="formatters">
      <FormattersSection />
    </CardSection>
  );
}

export function ProjectsPane(props: PaneProps) {
  return (
    <CardSection {...props} id="trusted-projects">
      <TrustedProjects />
    </CardSection>
  );
}
