import GitSection from "./GitSection";
import GithubSection from "./GithubSection";
import { CardSection, type PaneProps } from "../../components/paneKit";

/** Git itself, then the forge account and its kill switch. */
export default function IntegrationsPane(props: PaneProps) {
  return (
    <>
      <CardSection {...props} id="git">
        <GitSection />
      </CardSection>
      <CardSection {...props} id="github">
        <GithubSection />
      </CardSection>
    </>
  );
}
