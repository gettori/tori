// The old names over `./topicMembers` while callers move; only the old names, so
// a half-moved import cannot pass as done.

export type { SpaceProject, SpaceTint, ChipStyle, TintedMember, MemberRoot, MemberGroup } from "./topicMembers";
export {
  resolveMemberRestriction,
  OUTSIDE_MEMBERS_LABEL,
  groupByMemberRoot,
  CHIP_CAP,
  memberSectionsHeaded,
  spaceOfMember,
  projectOfMember,
  projectUnitKind,
  tintedMember,
  tintedMembers,
  memberFor,
  focusMemberRoot,
  createTopicMembers as createFeatureMembers,
} from "./topicMembers";
