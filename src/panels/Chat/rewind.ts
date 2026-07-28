// What a rewind says, in one place.
//
// A rewind is three separate things happening together - the tree goes back to
// a turn's checkpoint, the panel's replay is cut at that turn, and a fork
// carries the conversation into a new session - and exactly one of them is
// leaky: the fork spawns `--resume <old> --fork-session`, so the agent's context
// is the *whole* original conversation, including the turns just undone. It
// remembers writing files that are no longer on disk.
//
// That is the cost the mechanism was chosen with, not a defect discovered
// afterwards, so it is stated three times over: in the confirm before anything
// is written, in a banner on the rewound tab, and in the first message the new
// session is seeded with. The strings live here rather than inline so the three
// cannot drift apart, and so what they promise is assertable.

/** The confirm, shown before the tree is touched. Reverting is the reversible
 *  part (a backstop checkpoint is written first); the memory is not. */
export const REWIND_CAVEAT =
  "The new chat keeps this conversation's memory, including the turns you are undoing. It is told the files went back, but it will still remember the approach it took.";

/** The banner the rewound tab wears, so the gap between what is on screen and
 *  what the agent knows is visible rather than inferred from behaviour. */
export const REWIND_BANNER =
  "Rewound. The files and the conversation above are back to this point, but the agent still remembers the turns that were undone.";

/**
 * The first message the rewound session is seeded with.
 *
 * Left in the composer as a draft rather than sent, for two reasons. The user
 * rewound in order to try something different, so the turn they actually want
 * is this plus their new instruction, and sending on their behalf would spend a
 * turn on the announcement alone. And a draft can be edited or deleted, which a
 * hidden system preamble cannot.
 *
 * Addressed to the agent, so it reads as an instruction rather than as a note
 * about the agent written where the agent can see it. Spike 2 is the reason it
 * asks for a re-read explicitly rather than trusting the fact to imply one: a
 * denial naming its own fix reliably produced a retry but only 7 times in 9
 * produced the re-read it asked for, so "the files changed" cannot be assumed to
 * mean "so I will look again".
 */
export function rewindSeed(): string {
  return [
    "The working tree has been rewound to this point: every file edit after it is gone from disk.",
    "You still remember making those edits. Do not assume any of it is there - read a file before you change it.",
    "",
    "",
  ].join("\n");
}
