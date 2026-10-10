import { CardSection, Group, type PaneProps } from "../../components/paneKit";
import ProjectList from "./ProjectList";
import TrustedProjects from "./TrustedProjects";

/** The projects Tori found, each opening its settings tab, then the trusted
 *  list, which also holds paths that are not projects Tori found. */
export default function ProjectsPane(props: PaneProps) {
  return (
    <>
      <Group {...props} title="Projects" ids={["projects-list"]}>
        <CardSection {...props} id="projects-list">
          <ProjectList trust />
        </CardSection>
      </Group>
      <CardSection {...props} id="trusted-projects">
        <TrustedProjects />
      </CardSection>
    </>
  );
}
