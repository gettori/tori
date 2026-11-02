import { For, Show, createMemo, type JSX } from "solid-js";
import TopicItem from "./TopicItem";
import type { TopicSpace } from "./TopicList";
import type { TopicActions } from "./topicActions";
import { byName, isReference, memberBranch, memberPrBranch, memberRoot, type Topic } from "../../utils/topics";
import type { Rollup } from "../../utils/sessionStatus";
import { syncFor } from "../../utils/branchSync";
import { finishedPr } from "../../utils/prRelation";
import { forgePause, unitStatus } from "../../utils/forgeStatus";
import styles from "./TopicList.module.css";

export function matchesTopic(topic: Topic, query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    !q || topic.name.toLowerCase().includes(q) || topic.members.some((m) => m.displayName.toLowerCase().includes(q))
  );
}

export default function TopicRows(props: {
  topics: readonly Topic[];
  query: string;
  spaces: TopicSpace[];
  actions: TopicActions;
  activeId?: string | null;
  activeRoot?: string | null;
  onOpenMember?: (topic: Topic, root: string) => void;
  topicStatus?: (topic: Topic) => Rollup | null;
  fallback?: JSX.Element;
}) {
  const visible = createMemo(() => [...props.topics].sort(byName).filter((t) => matchesTopic(t, props.query)));
  const actions = () => props.actions;

  return (
    <Show when={visible().length > 0} fallback={props.fallback}>
      <ul class={styles.items} data-no-window-drag>
        <For each={visible()}>
          {(f) => (
            <TopicItem
              topic={f}
              spaces={props.spaces}
              active={props.activeId === f.id}
              activeRoot={props.activeRoot}
              onSelectMember={(m) => {
                const root = memberRoot(m);
                if (root) props.onOpenMember?.(f, root);
              }}
              onRepair={(m, action) => void actions().repair(f, m, action)}
              menu={actions().menu(f)}
              memberMenu={actions().memberMenu(f)}
              memberSync={(m) => syncFor(memberRoot(m), memberBranch(m, f.branch))}
              status={() => props.topicStatus?.(f) ?? null}
              memberPr={(m) => {
                const branch = memberPrBranch(m, f.branch);
                return forgePause(m.repoPath) || !branch ? null : unitStatus(m.repoPath, branch);
              }}
              memberFinished={(m) => {
                // A reference sits on the repo's default branch, whose PRs are
                // not this Topic's.
                const branch = memberPrBranch(m, f.branch);
                if (isReference(m) || !branch) return null;
                return finishedPr(memberRoot(m), branch, syncFor(memberRoot(m), branch));
              }}
              onReorder={(repoPaths) => void actions().reorder(f, repoPaths)}
              expanded={!!actions().expanded()[f.id]}
              onExpand={(open) => actions().setExpanded((prev) => ({ ...prev, [f.id]: open }))}
            />
          )}
        </For>
      </ul>
    </Show>
  );
}
