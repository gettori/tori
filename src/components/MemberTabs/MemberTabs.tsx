import { For, Show } from "solid-js";
import { Tabs } from "../../lib/tabs";
import Tab from "../Tab/Tab";
import ProjectIcon from "../Icon/ProjectIcon";
import type { TintedMember } from "../../utils/topicMembers";
import patterns from "../../styles/patterns.module.css";
import styles from "./MemberTabs.module.css";

/** One tab per Topic member, sharing the strip's width equally, for a right
 *  panel pane that shows one member at a time. A pane that can show a broken
 *  member's repair leaves `canPick` off, so every tab stays pickable. */
export default function MemberTabs(props: {
  members: readonly TintedMember[];
  activeKey: string | null;
  onPick: (m: TintedMember) => void;
  canPick?: (m: TintedMember) => boolean;
  count?: (m: TintedMember) => number;
}) {
  const countOf = (m: TintedMember) => props.count?.(m) ?? 0;
  const filesWord = (n: number) => `changed file${n === 1 ? "" : "s"}`;
  const nameOf = (m: TintedMember) => {
    const name = m.state.usable ? m.label : `${m.label}: ${m.state.label}`;
    const n = countOf(m);
    return n ? `${name}, ${n} ${filesWord(n)}` : name;
  };
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
              trailing={
                <Show when={countOf(m)}>
                  <span class={styles.count} aria-hidden="true" data-count>
                    {countOf(m)}
                  </span>
                  <span class={patterns.srOnly}>{`, ${countOf(m)} ${filesWord(countOf(m))}`}</span>
                </Show>
              }
            >
              {m.label}
            </Tab>
          )}
        </For>
      </Tabs.List>
    </Tabs.Root>
  );
}
