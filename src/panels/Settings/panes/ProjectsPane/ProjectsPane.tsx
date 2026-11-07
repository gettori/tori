import { CardSection, type PaneProps } from "../../components/paneKit";
import ProjectTrust from "./ProjectTrust";
import UnattendedLists from "./UnattendedLists";

/** The projects Tori found, each with its trust and a door to its settings,
 *  then the unattended lists. */
export default function ProjectsPane(props: PaneProps) {
  return (
    <>
      <CardSection {...props} id="projects-list">
        <ProjectTrust />
      </CardSection>
      <UnattendedLists {...props} />
    </>
  );
}
