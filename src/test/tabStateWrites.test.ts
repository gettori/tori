// The guard for tab-state monotonicity (plan phase 2: lazy tab restore).
//
// ## Why this counts writes instead of testing for a backward move
//
// A tab now has a position on `inert -> open -> live`, and the whole safety
// argument rests on it never going back: the stage mounts a live surface behind
// a latch, `closeId` skips `pty_kill` for anything short of `live`, and four
// consumers read `live` as "something is actually running". A tab walked
// backwards would unmount a live PTY, leak a process on close, and undercount a
// destructive confirm.
//
// The obvious test - "assert no code path moves a tab back" - is the one that
// must not be written. It is a negative over the whole repo, and it passes
// vacuously the day someone adds a write it has never heard of, with nothing to
// say so. `advanceTabState` already refuses a backward move at runtime; what
// this file adds is that no *new* door can appear without being looked at.
//
// So it classifies nothing. It counts every call to a function that writes tab
// state and requires each file holding one to be named below with a reason and
// an exact count. A write in a file this guard has never heard of changes a
// count or misses an entry, and fails. Same shape as
// `src/test/interactiveTitle.test.ts` and `scripts/check-tokens.mjs`:
// exemptions are named, and each one states why.
//
// ## Scope: `.ts` and `.tsx`, and why this file is not in its own scan
//
// The writers are plain functions rather than JSX, so both extensions are in
// range - which would otherwise make this file report itself for every writer
// it names in prose. It does not, because Vite excludes the importing module
// from its own `import.meta.glob`. That is load-bearing and invisible, so the
// suite below asserts it rather than trusting it (the vault's gotcha on a
// source-scanning test reading itself).
import { describe, expect, it } from "vite-plus/test";

// Vite writes a sibling's key relative to the importer, so `src/test/frames.ts`
// arrives as `./frames.ts` while everything else arrives as `../panels/...`.
// Both are normalised to one shape, so an entry below reads the same way
// whichever folder its file is in.
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, source]) => [path.replace(/^\.\.\//, "").replace(/^\.\//, "test/"), source]),
);

/**
 * Every function that can change what state a tab is in.
 *
 * `setTabStates` is the raw signal setter and is module-private, so it can only
 * appear in the store itself. It is listed anyway, because a guard that knows
 * only the public doors stops being a guard the moment someone exports the
 * private one.
 */
const WRITERS = ["advanceTabState", "seedInert", "dropTabState", "setTabStates"];

const WRITE_RE = new RegExp(String.raw`\b(${WRITERS.join("|")})\s*\(`, "g");

/** A file that writes tab state, why it is allowed to, and how often. */
interface Allowed {
  count: number;
  reason: string;
}

const ALLOWED = new Map<string, Allowed>([
  [
    "panels/Terminal/terminalTabStore.ts",
    {
      count: 7,
      reason:
        "the store itself: three exported doors (advanceTabState, seedInert, dropTabState), the raw setter each of them calls, and the reset. advanceTabState is where the ordering is enforced, and every write in the app goes through one of these",
    },
  ],
  [
    "panels/Terminal/Terminal.tsx",
    {
      count: 6,
      reason:
        "the panel owns every transition a person can cause: a restore seeds a tab inert, and drops that seed again when the tab it was for was never taken up; a tab that comes on screen wakes one step; a first send starts a chat, whether it was a draft or a restored transcript; and a closed tab leaves no record behind",
    },
  ],
  [
    "panels/Terminal/tabState.test.ts",
    { count: 16, reason: "the state machine's own table-driven test, which has to drive these directly" },
  ],
]);

/** Every file that writes tab state, with how many writes. */
function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const [path, source] of Object.entries(SOURCES)) {
    const count = source.match(WRITE_RE)?.length ?? 0;
    if (count > 0) found.set(path, count);
  }
  return found;
}

describe("the tab-state write guard", () => {
  it("scans the whole of src, so a passing run means something", () => {
    // Floors far below the real numbers: this catches a glob that broke, not a
    // folder that grew. A guard whose scan quietly matches nothing passes every
    // assertion after it.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(SOURCES)).toContain("panels/Terminal/terminalTabStore.ts");
    // Both key shapes, since the two arrive differently and a normalisation
    // that broke would silently drop one whole folder.
    expect(Object.keys(SOURCES)).toContain("test/interactiveTitle.test.ts");
    expect(scan().size).toBeGreaterThan(0);
  });

  // Vite excludes the importer from its own glob, which is the only reason this
  // file's prose does not count as writes. Asserted, because if that ever
  // changed the fix would look like "add an exemption for the guard" rather
  // than "the scan changed shape underneath it".
  it("is not in its own scan", () => {
    expect(Object.keys(SOURCES)).not.toContain("test/tabStateWrites.test.ts");
  });

  it("names every file that writes tab state", () => {
    const unlisted = [...scan().keys()].filter((path) => !ALLOWED.has(path));

    // The whole point of failing open: a new file, or a file that grew a write
    // this guard has never seen, lands here rather than slipping past.
    expect(unlisted).toEqual([]);
  });

  it("holds each entry to its exact count", () => {
    const found = scan();
    const drifted: string[] = [];
    for (const [path, entry] of ALLOWED) {
      const actual = found.get(path) ?? 0;
      if (actual !== entry.count) drifted.push(`${path}: listed ${entry.count}, found ${actual}`);
    }

    // Exact, not "at most": a file that gained a write fails here even though it
    // is already listed, and one that lost its last write fails until its entry
    // goes, so neither list can rot into a blanket pardon.
    expect(drifted).toEqual([]);
  });
});
