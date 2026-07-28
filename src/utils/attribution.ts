// Why a file can appear in a turn's changes with no session claiming it.
//
// A turn's file list is the tree diff narrowed by what the session recorded
// writing. That recording is exact for tools that name their target and blind
// to the ones that do not - a `Bash` heredoc writes a file and mentions it
// nowhere - so a turn containing one is graded `partial` and its list widens to
// include tree changes no session claims.
//
// Those changes are *candidates*. The likeliest author is this session's own
// unparseable write; the other possibility is a live agent in the same folder,
// and reverting on the guess destroys work whose bytes the backstop can restore
// but whose context it cannot. One sentence, shared by every surface that shows
// such a file, so none of them can drift into implying Sway knows.
export const UNATTRIBUTED_NOTICE =
  "Nothing recorded which session wrote this: the turn ran shell commands, whose writes Sway cannot see. It may belong to another agent working in this folder.";
