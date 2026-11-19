import { invoke } from "@tauri-apps/api/core";
import { topics } from "./topicStore";
import { isChatKey, isTopicKey, topicKey, type Topic } from "./topics";
import { liveOrigin, mentionLabel, unitAt } from "./navIndex";
import { mentionId, offeredMention, type Mention } from "./sessionIssues";
import { unitIssueOf, type Issue } from "./issues";

type Target = { projectPath: string } & ({ topic: Topic } | { branch: string });

export type LinkOffer = { mention: Mention; label: string; to: string; link: () => Promise<void> };

// A Home chat has nothing to link to, and a worktree or Topic with an issue
// already has its one.
function targetOf(workspace: string): Target | null {
  if (isChatKey(workspace)) return null;
  if (isTopicKey(workspace)) {
    const topic = topics().find((t) => topicKey(t.id) === workspace);
    const first = topic && [...topic.members].sort((a, b) => a.order - b.order)[0];
    return topic && first && !topic.issue ? { topic, projectPath: first.repoPath } : null;
  }
  const unit = unitAt(workspace);
  return unit && !unit.issue ? { projectPath: unit.projectPath, branch: unit.branch } : null;
}

// The store keeps only the repo and number, so the title and URL the link
// shows are asked for on the click.
async function link(target: Target, m: Mention) {
  const key = `${m.owner}/${m.repo}#${m.number}`;
  const issue = unitIssueOf(await invoke<Issue>("issues_get", { projectPath: target.projectPath, key }));
  if ("topic" in target) await invoke("set_topic_issue", { topicId: target.topic.id, issue });
  else await invoke("issues_record", { projectPath: target.projectPath, branch: target.branch, issue });
}

export function linkOffer(session: string, workspace: string): LinkOffer | null {
  const target = targetOf(workspace);
  const mention = target && offeredMention(session);
  if (!target || !mention) return null;
  return {
    mention,
    label: mentionLabel(mentionId(mention), liveOrigin(target.projectPath)),
    to: "topic" in target ? target.topic.name : target.branch,
    link: () => link(target, mention),
  };
}
