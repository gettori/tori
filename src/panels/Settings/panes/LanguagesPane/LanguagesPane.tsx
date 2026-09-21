import { createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import LspSection, { type LspHealth } from "./LspSection";
import LintFormatSection from "./LintFormatSection";
import DapSection from "./DapSection";
import TrustedProjects from "./TrustedProjects";
import { CardSection, type PaneProps } from "../../components/paneKit";
import { overlayRoot } from "../../settingsStore";

/**
 * Language servers, linters and formatters, debug adapters, and trusted projects.
 *
 * Sections whose rows only exist at runtime, one per thing installed or
 * trusted, so each carries a single catalogue entry standing for the whole
 * section and is shown, hidden and marked whole. There is nothing here to
 * filter row by row.
 */
export default function LanguagesPane(props: PaneProps) {
  // Linters are servers too, and one probe runs every server's binary.
  const [health, { refetch }] = createResource(() => invoke<LspHealth[]>("lsp_health", { root: overlayRoot() }));
  const onChange = () => Promise.resolve(refetch());
  return (
    <>
      <CardSection {...props} id="language-servers">
        <LspSection health={health} onChange={onChange} />
      </CardSection>
      <CardSection {...props} id="linters-formatters">
        <LintFormatSection health={health} onChange={onChange} />
      </CardSection>
      <CardSection {...props} id="debuggers">
        <DapSection />
      </CardSection>
      <CardSection {...props} id="trusted-projects">
        <TrustedProjects />
      </CardSection>
    </>
  );
}
