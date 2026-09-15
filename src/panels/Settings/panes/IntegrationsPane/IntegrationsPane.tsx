import GitSection from "./GitSection";
import ForgeSection from "./ForgeSection";
import { CardSection, type PaneProps } from "../../components/paneKit";

/** Git itself, then the forge accounts and their kill switch. */
export default function IntegrationsPane(props: PaneProps) {
  return (
    <>
      <CardSection {...props} id="git">
        <GitSection />
      </CardSection>
      <CardSection {...props} id="forge">
        <ForgeSection />
      </CardSection>
    </>
  );
}
