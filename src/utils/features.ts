// The old names over `./topics` while callers move; only the old names, so a
// half-moved import cannot pass as done.

export type { MemberState, Member, Topic as Feature, MemberStateSummary, RepairAction } from "./topics";
export {
  topicSlug as featureSlug,
  memberInitials,
  REPAIR_LABEL,
  memberState,
  LAST_MEMBER,
  TOPIC_KEY_PREFIX as FEATURE_KEY_PREFIX,
  topicKey as featureKey,
  isTopicKey as isFeatureKey,
  SHELLS_KEY,
  isShellsKey,
  topicRoots as featureRoots,
  topicSelection as featureSelection,
  rootOf,
  workspaceKey,
  selectionRoot,
  workspaceFolders,
  ownsCwd,
  tabUnderFolder,
} from "./topics";
