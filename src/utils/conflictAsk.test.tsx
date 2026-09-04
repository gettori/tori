import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConflictOp, ConflictStages } from "./conflict";
import type { SessionTarget } from "./safeSend";

// "Ask the agent to resolve this conflict": the message, and the one path that
// sends it. The message is the part that can be quietly wrong - it names sides
// whose meaning inverts under a rebase, and it is pasted into a prompt, so a
// stray newline would submit half of it - so most of this is the composer,
// tested as three stages in and one sentence out.
//
// A `.tsx` with no JSX in it (the same reason fontLoad's test is one): the send
// half rides the window event bus, so it needs a document, and the extension is
// what picks the environment.

const REPO = "/space/proj/main";
const TARGET: SessionTarget = {
  sessionId: "s1",
  agent: "claude",
  profile: null,
  folderPath: REPO,
  sessionCwd: REPO,
};

// Two spots both sides rewrote, with an insertion by ours in between so the
// line numbers on the two sides really do diverge (the same shape the model's
// own tests use).
const BASE = ["one", "two", "three", "four", "five", "six", "seven", ""].join("\n");
const OURS = ["one", "OURS-A", "three", "EXTRA", "four", "five", "OURS-B", "seven", ""].join("\n");
const THEIRS = ["one", "THEIRS-A", "three", "four", "five", "THEIRS-B", "seven", ""].join("\n");
const STAGES: ConflictStages = { base: BASE, ours: OURS, theirs: THEIRS, binary: false };

let stages: ConflictStages | null = STAGES;
let op: ConflictOp | null = "merge";
const asked: { cmd: string; args: unknown }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    asked.push({ cmd, args });
    switch (cmd) {
      // A bare string, which is how a `Result<_, String>` command actually
      // rejects: the backend's own wording, not an Error wrapped around it.
      case "git_conflict_stages":
        return stages ? Promise.resolve(stages) : Promise.reject("src/a.ts has no merge conflict.");
      case "git_conflict_op":
        return op ? Promise.resolve(op) : Promise.reject(new Error("no op"));
      default:
        return Promise.resolve(null);
    }
  },
}));

const { composeConflictAsk, askAgentToResolve } = await import("./conflictAsk");
const { sanitizeForSend } = await import("./safeSend");
const { onWith, emitWith, SEND_TO_SESSION, SEND_TO_SESSION_RESULT, TOAST } = await import("./events");
type Sent = { requestId: string; text: string; sessionId: string };

/** Stand in for Terminal.tsx: take the request off the bus and answer it, so
 *  `requestSend` resolves instead of sitting out its own timeout. */
function collectSends(result: "sent" | "blocked" | "timeout" = "sent"): { sent: Sent[]; off: () => void } {
  const sent: Sent[] = [];
  const off = onWith<Sent>(SEND_TO_SESSION, (req) => {
    sent.push(req);
    emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result });
  });
  return { sent, off };
}

beforeEach(() => {
  stages = STAGES;
  op = "merge";
  asked.length = 0;
});

describe("composing the ask", () => {
  it("names the file, the disputed regions, and where to read the three versions", () => {
    const text = composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", STAGES);

    // Relative to the session's cwd, the drag-mention convention every other
    // composed message follows.
    expect(text).toContain("@src/a.ts");
    // Both conflicts, in ours' own line numbers: ours has an insertion above
    // the second one, so quoting base's numbers there would point a line high.
    expect(text).toContain("2 regions in dispute, at `:2:` lines 2, 7");
    // The whole reason for pointing at the index: git's markers hold stages 2
    // and 3, and the base - the thing that says what each side changed - is not
    // in the file at all.
    expect(text).toContain("git show :1:src/a.ts");
    expect(text).toContain("git add -- src/a.ts");
  });

  it("stays on one line, so the prompt cannot submit half of it", () => {
    // The safe-send contract: the text is pasted, unsubmitted, and a raw
    // newline in a PTY write is a carriage return at an agent's prompt.
    const text = composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", STAGES);
    expect(text).not.toMatch(/\n/);
    expect(sanitizeForSend(text)).toBe(text);
  });

  it("names the sides by stage first, and inverts what they mean under a rebase", () => {
    // The one thing an agent cannot recover on its own: mid-rebase git checks
    // out the upstream and replays your commits, so `:2:` is *not* your work.
    // "Keep ours" would sound right and keep the wrong side.
    const merge = composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", STAGES);
    const rebase = composeConflictAsk(TARGET, REPO, "src/a.ts", "rebase", STAGES);

    expect(merge).toContain("`:2:` is Yours (HEAD)");
    expect(rebase).toContain("`:2:` is Upstream");
    expect(rebase).toContain("`:3:` is Yours (being replayed)");
  });

  it("names a region by where it goes when the side has no lines there", () => {
    // Ours deleted what theirs edited: there is nothing of ours to point at, so
    // a line number would be a line belonging to something else.
    const base = ["one", "two", "three", ""].join("\n");
    const ours = ["one", "three", ""].join("\n");
    const theirs = ["one", "TWO", "three", ""].join("\n");

    const text = composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", {
      base,
      ours,
      theirs,
      binary: false,
    });

    expect(text).toContain("at `:2:` lines before 2");
  });

  it("asks whether the file survives when one side deleted it", () => {
    // Not a merge at all: offering to take a side would stage an *empty* file
    // where git means *no* file. `-f` because the path is still unmerged.
    const text = composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", {
      base: BASE,
      ours: OURS,
      theirs: null,
      binary: false,
    });

    expect(text).toContain("Incoming deleted the file and Yours (HEAD) changed it");
    expect(text).toContain("git rm -f -- src/a.ts");
    expect(text).not.toContain("in dispute");
  });

  it("offers a whole-side take for a binary file", () => {
    const text = composeConflictAsk(TARGET, REPO, "logo.png", "merge", {
      base: null,
      ours: "",
      theirs: "",
      binary: true,
    });

    expect(text).toContain("binary");
    expect(text).toContain("git checkout --ours -- logo.png");
    expect(text).toContain("git checkout --theirs -- logo.png");
    expect(text).not.toContain("git show :1:");
  });

  it("stops listing regions long before it becomes a paragraph, and says how many it left", () => {
    // A generated file can conflict in dozens of places. The count is the
    // useful part; forty line numbers pasted into a prompt is not.
    const n = 12;
    const base = Array.from({ length: n * 2 }, (_, i) => (i % 2 ? "x" : `line${i}`)).join("\n");
    const ours = base.replace(/^x$/gm, "OURS");
    const theirs = base.replace(/^x$/gm, "THEIRS");

    const text = composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", { base, ours, theirs, binary: false });

    expect(text).toContain(`${n} regions in dispute`);
    expect(text).toContain(`and ${n - 8} more`);
  });

  it("leaves an absolute path alone when the session sits outside the repo", () => {
    // Same rule as every other composed mention: a path the agent's cwd does
    // not contain has to stay addressable from where the agent actually is.
    const text = composeConflictAsk({ ...TARGET, sessionCwd: "/elsewhere" }, REPO, "src/a.ts", "merge", STAGES);
    expect(text).toContain(`@${REPO}/src/a.ts`);
  });
});

describe("sending the ask", () => {
  it("reads the conflict itself, then routes the composed text through safe-send", async () => {
    // The caller holds a path and nothing else, which is what lets a row in the
    // Changes panel ask for a file it has never opened.
    const { sent, off } = collectSends();
    await askAgentToResolve(TARGET, REPO, "src/a.ts");
    off();

    expect(asked.map((a) => a.cmd)).toEqual(["git_conflict_stages", "git_conflict_op"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(composeConflictAsk(TARGET, REPO, "src/a.ts", "merge", STAGES));
    expect(sent[0].sessionId).toBe("s1");
  });

  it("still asks when git will not say which operation it is", async () => {
    // `none` is a real answer (a conflicted `git stash apply` records no state
    // at all), so an unreadable operation degrades to the merge orientation
    // rather than refusing to ask.
    op = null;
    const { sent, off } = collectSends();
    await askAgentToResolve(TARGET, REPO, "src/a.ts");
    off();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(composeConflictAsk(TARGET, REPO, "src/a.ts", "none", STAGES));
  });

  it("says why and sends nothing when the conflict is already gone", async () => {
    // The merge can be finished or aborted in the terminal under an open panel.
    // Asking an agent to resolve what no longer exists is worse than silence.
    stages = null;
    const toasts: string[] = [];
    const offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t.message));
    const { sent, off } = collectSends();

    await askAgentToResolve(TARGET, REPO, "src/a.ts");
    off();
    offToast();

    expect(sent).toEqual([]);
    expect(toasts).toEqual(["src/a.ts has no merge conflict."]);
  });

  it("says so when no terminal answers at all", async () => {
    // requestSend's own timeout: nothing else is listening, so nothing else
    // would report it.
    const toasts: string[] = [];
    const offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t.message));
    const { off } = collectSends("timeout");

    await askAgentToResolve(TARGET, REPO, "src/a.ts");
    off();
    offToast();

    expect(toasts).toEqual(["Couldn't reach the session, try again."]);
  });
});
