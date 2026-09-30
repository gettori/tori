import { For } from "solid-js";
import { Tabs } from "../../lib/tabs";
import Tab from "../Tab/Tab";
import ProjectIcon from "../Icon/ProjectIcon";
import type { TintedMember } from "../../utils/topicMembers";
import styles from "./MemberTabs.module.css";

/** One tab per Topic member, sharing the strip's width equally, for a right
 *  panel pane that shows one member at a time. A pane that can show a broken
 *  member's repair leaves `canPick` off, so every tab stays pickable. */
export default function MemberTabs(props: {
  members: readonly TintedMember[];
  activeKey: string | null;
  onPick: (m: TintedMember) => void;
  canPick?: (m: TintedMember) => boolean;
}) {
  const nameOf = (m: TintedMember) => (m.state.usable ? m.label : `${m.label}: ${m.state.label}`);
  return (
    <Tabs.Root
      value={props.activeKey ?? undefined}
      onChange={(key) => {
        const m = props.members.find((x) => x.key === key);
        if (m) props.onPick(m);
      }}
    >
      <Tabs.List class={styles.strip} aria-label="Topic members">
        <For each={props.members}>
          {(m) => (
            <Tab
              quiet
              value={m.key}
              class={styles.memberTab}
              icon={<ProjectIcon {...m.icon} />}
              tooltip={nameOf(m)}
              disabled={props.canPick ? !props.canPick(m) : false}
              tooltipWhenDisabled
              data-member={m.member.repoPath}
              data-state={m.member.state.kind}
            >
              {m.label}
            </Tab>
          )}
        </For>
      </Tabs.List>
    </Tabs.Root>
  );
}
