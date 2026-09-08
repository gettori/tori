import { describe, it, expect } from "vitest";
import goldenEvents from "../../dev/fixtures/chat/events.json";
import goldenCommands from "../../dev/fixtures/chat/commands.json";
import goldenToolSummaries from "../../dev/fixtures/chat/toolSummaries.json";
import goldenConversation from "../../dev/fixtures/chat/conversationEvents.json";
import {
  CHAT_COMMAND_KEYS,
  CHAT_COMMAND_TYPES,
  CHAT_EVENT_KEYS,
  CHAT_EVENT_TYPES,
  CHAT_NESTED_KEYS,
  CONVERSATION_EVENTS,
  isTurnScoped,
  parseChatEvent,
  type ChatCommand,
  type ChatEvent,
  type ToolSummary,
} from "./chatTypes";

// These fixtures are written by the Rust round-trip test
// (`emit_wire_samples_for_the_typescript_mirror` in chat/model.rs), one sample
// per variant, serialized by the same serde impls the real transport uses.
//
// That is the whole point: hand-writing samples on this side would prove the
// mirror is self-consistent, not that it matches Rust. Parsing Rust's own
// output means a renamed field fails here rather than surviving as two halves
// that each look fine and disagree on the wire.

describe("chatTypes mirrors the Rust chat model", () => {
  it("parses one real event per variant", () => {
    for (const raw of goldenEvents) {
      const parsed = parseChatEvent(raw);
      expect(parsed, `failed to parse ${JSON.stringify(raw).slice(0, 120)}`).not.toBeNull();
      expect(parsed?.type).toBe((raw as { type: string }).type);
    }
  });

  // Which frames are "the conversation" is one decision made in Rust and read
  // in two places: the mirror rebuilds the log when a replay brings one, and the
  // panel clears what it drew from that log for the same reason. A list typed
  // out twice would eventually be two lists, and the drift would surface as a
  // restored chat showing its history twice.
  it("agrees with Rust on which frames are the conversation", () => {
    expect([...goldenConversation].sort()).toEqual([...CONVERSATION_EVENTS].sort());
  });

  it("covers every variant the Rust model emits, with none left over", () => {
    const fromRust = goldenEvents.map((e) => (e as { type: string }).type).sort();
    expect(fromRust).toEqual([...CHAT_EVENT_TYPES].sort());

    const commandsFromRust = goldenCommands.map((c) => (c as { type: string }).type).sort();
    expect(commandsFromRust).toEqual([...CHAT_COMMAND_TYPES].sort());
  });

  // The half that actually catches a rename.
  //
  // The obvious version - assigning the imported JSON to `ChatEvent[]` and
  // letting tsc reconcile it - does not work and was verified not to work: a
  // JSON import infers `type: string` rather than the literal union, so the
  // assignment needs a cast, and a cast checks nothing. Renaming Rust's
  // `turnId` to `turnRef` left `tsc --noEmit` completely clean.
  //
  // So the field names are compared as data against Rust's own serialized
  // output. `CHAT_EVENT_KEYS` is a `Record` over the variant union, so a new
  // variant still fails at compile time; this test covers the fields.
  it("agrees with Rust on every field name, variant by variant", () => {
    for (const raw of goldenEvents as ChatEvent[]) {
      const spec = CHAT_EVENT_KEYS[raw.type];
      const actual = Object.keys(raw)
        .filter((k) => k !== "type")
        .sort();
      const allowed = [...spec.required, ...(spec.optional ?? [])].sort();

      for (const key of spec.required) {
        expect(actual, `${raw.type} is missing ${key} on the wire`).toContain(key);
      }
      for (const key of actual) {
        expect(allowed, `${raw.type} carries an undeclared field ${key}`).toContain(key);
      }
    }

    for (const raw of goldenCommands as ChatCommand[]) {
      const spec = CHAT_COMMAND_KEYS[raw.type];
      const actual = Object.keys(raw)
        .filter((k) => k !== "type")
        .sort();
      const allowed = [...spec.required, ...(spec.optional ?? [])].sort();
      for (const key of spec.required) {
        expect(actual, `${raw.type} is missing ${key} on the wire`).toContain(key);
      }
      for (const key of actual) {
        expect(allowed, `${raw.type} carries an undeclared field ${key}`).toContain(key);
      }
    }
  });

  it("has a sample for every variant on both sides", () => {
    expect(goldenEvents).toHaveLength(CHAT_EVENT_TYPES.length);
    expect(goldenCommands).toHaveLength(CHAT_COMMAND_TYPES.length);
  });

  // An exhaustive switch: adding a variant to ChatEvent without handling it
  // here fails to compile, so the union and the fixtures cannot drift apart
  // silently.
  it("narrows every variant exhaustively", () => {
    const seen = new Set<string>();
    for (const ev of goldenEvents as ChatEvent[]) {
      switch (ev.type) {
        case "sessionStarted":
          expect(ev.slashCommands[0]?.name).toBe("review");
          expect(ev.permissionMode).toBe("bypassPermissions");
          // The two model ids are separate fields on purpose; a mirror that
          // collapsed them would let the picker compare the wrong one.
          expect(ev.models[0]?.value).toBe("sonnet");
          expect(ev.models[0]?.resolvedModel).toBe("claude-sonnet-5");
          expect(ev.models[0]?.supportedEffortLevels).toContain("high");
          expect(ev.fastModeState).toBe("off");
          expect(ev.fastModeDisabledReason).toBe("sdk_opt_in_required");
          // `CHAT_EVENT_KEYS` compares only the event's own top-level keys, so
          // a rename *inside* `ChatAccount` would slip past it. Read every
          // field here instead: `undefined` on a renamed one fails the compare.
          expect(ev.account?.subscriptionType).toBe("Claude Pro");
          expect(ev.account?.organization).toBe("Acme");
          expect(ev.account?.apiProvider).toBe("firstParty");
          break;
        case "sessionReady":
          // The pre-turn liveness signal carries both catalogues, which is
          // what puts the picker and the command menu on live data before the
          // first message.
          expect(ev.slashCommands[0]?.name).toBe("review");
          expect(ev.models[0]?.value).toBe("sonnet");
          // Carried a turn earlier than `sessionStarted`, and the handshake is
          // its only source, so this is where it first reaches the UI.
          expect(ev.account?.apiProvider).toBe("firstParty");
          break;
        case "turnStarted":
          expect(ev.turnId).toBeTruthy();
          // False on the sample: the ordinary turn is the one a user sent.
          expect(ev.agentInitiated).toBe(false);
          break;
        case "hookFired":
          // The measured shape: `name` reports the tool, not the configured
          // matcher, which is exactly why `swayOwned` cannot be derived from it.
          expect(ev.name).toBe("PreToolUse:Bash");
          expect(ev.event).toBe("PreToolUse");
          expect(ev.phase).toBe("finished");
          expect(ev.swayOwned).toBe(false);
          expect(ev.exitCode).toBe(0);
          break;
        case "compacted":
          // The figures are what make "it reclaimed context" checkable rather
          // than a claim; the summary is the agent's own words.
          expect(ev.preTokens).toBeGreaterThan(ev.postTokens!);
          expect(ev.trigger).toBe("manual");
          expect(ev.summary).toContain("continued from a previous conversation");
          break;
        case "userMessage":
          // History's counterpart to the composer's own push, so it carries the
          // same block shapes a sent turn does.
          expect(ev.blocks[0]).toEqual({ type: "text", text: "fix the bug" });
          break;
        case "textDelta":
        case "thinkingDelta":
          expect(typeof ev.text).toBe("string");
          break;
        case "toolCallStarted":
          expect(ev.name).toBe("Bash");
          break;
        case "toolCallProgress":
          expect(typeof ev.partialInput).toBe("string");
          break;
        case "toolCallCompleted":
          expect(ev.files).toContain("/tmp/w/probe.txt");
          break;
        case "fileEdit":
          expect(ev.kind).toBe("modified");
          break;
        case "permissionRequest":
          expect(ev.requestId).toBeTruthy();
          break;
        case "questionRequest":
          // The sample is the widest measured shape: four questions is the cap
          // and four options is the cap, with one multi-select and one preview
          // so neither is only exercised by the nested-key test below.
          expect(ev.questions).toHaveLength(4);
          expect(ev.questions.some((q) => q.multiSelect)).toBe(true);
          expect(ev.questions[0]?.options[0]?.preview).toBeTruthy();
          break;
        case "planUpdate":
          expect(ev.items[0]?.status).toBe("inProgress");
          break;
        case "usage":
          expect(ev.usage.outputTokens).toBeGreaterThan(0);
          break;
        case "rateLimit":
          expect(ev.limitType).toBe("five_hour");
          break;
        case "turnCompleted":
          // The distinction the composer queue turns on.
          expect(ev.outcome).toBe("cancelled");
          expect(ev.permissionDenials[0]?.toolName).toBe("Bash");
          break;
        case "slashCommands":
          // The list an ACP agent publishes after its handshake, which is the
          // only way it ever arrives there.
          expect(ev.commands.map((c) => c.name)).toEqual(["plan"]);
          break;
        case "compactionStarted":
          // Carries nothing but its place in the turn: the news is that a
          // compaction is running at all.
          expect(ev.turnId).toBeTruthy();
          break;
        case "compactionFailed":
          // The agent's own reason, which is the whole of what a failed
          // compaction has to report - there is no boundary behind it.
          expect(ev.error).toBe("Not enough messages to compact.");
          break;
        case "sessionError":
          expect(ev.fatal).toBe(true);
          break;
        case "sessionEnded":
          expect(ev.reason).toBeTruthy();
          break;
        case "configOptions": {
          // The two shapes a mirrored control comes in, and the uncategorized
          // one is the row the mirror exists for.
          const toggle = ev.options.find((o) => o.kind === "boolean");
          expect(toggle?.kind === "boolean" && toggle.value).toBe(true);
          expect(toggle?.category).toBe("");
          const select = ev.options.find((o) => o.kind === "select");
          expect(select?.kind === "select" && select.current).toBe("concise");
          break;
        }
        case "modeRefused":
          // The agent's own sentence, verbatim: it is what the refused row shows.
          expect(ev.mode).toBe("bypassPermissions");
          expect(ev.reason).toContain("--dangerously-skip-permissions");
          break;
        case "subagentStarted":
          // The join this frame alone carries: the id a subagent's permission
          // prompt names, and the `Agent` call its nested frames point at.
          expect(ev.agentId).toBe("acb01121756a92ca0");
          expect(ev.toolUseId).toBe("toolu_5");
          expect(ev.agentType).toBe("general-purpose");
          break;
        case "subagentCall":
          // Membership, keyed on the call rather than carried by it.
          expect(ev.agentId).toBe("acb01121756a92ca0");
          expect(ev.toolUseId).toBe("toolu_01V4im1SuXMxH4xRjNuCDorw");
          break;
        case "subagentUpdate":
          // The agent's own status word, and the three figures a subagent
          // reports instead of a token breakdown.
          expect(ev.status).toBe("completed");
          expect(ev.usage?.totalTokens).toBe(10371);
          expect(ev.usage?.toolUses).toBe(1);
          break;
        default: {
          const never: never = ev;
          throw new Error(`unhandled event variant: ${JSON.stringify(never)}`);
        }
      }
      seen.add(ev.type);
    }
    expect(seen.size).toBe(CHAT_EVENT_TYPES.length);
  });

  it("narrows every command variant exhaustively", () => {
    for (const cmd of goldenCommands as ChatCommand[]) {
      switch (cmd.type) {
        case "sendTurn":
          // All three block shapes ride in one turn.
          expect(cmd.blocks.map((b) => b.type)).toEqual(["text", "image", "fileRef"]);
          break;
        case "steer":
          // Carries content like a turn, and is a distinct variant so a queued
          // mode or model switch is not spent delivering it.
          expect(cmd.blocks.map((b) => b.type)).toEqual(["text"]);
          break;
        case "interrupt":
        case "close":
          expect(cmd.sessionId).toBe("s1");
          break;
        case "respondPermission":
          expect(cmd.decision).toBe("deny");
          expect(cmd.scope).toBe("once");
          break;
        case "respondQuestion":
          // The three answer shapes: one pick, several picks, and free text
          // with no pick at all. `picks` and `freeText` are not exclusive, so
          // an empty `picks` is a real answer rather than a missing one.
          expect(cmd.answers.map((a) => a.picks.length)).toEqual([1, 2, 0]);
          expect(cmd.answers[2]?.freeText).toBeTruthy();
          break;
        case "setMode":
          expect(cmd.mode).toBe("plan");
          break;
        case "setModel":
          expect(cmd.effort).toBe("xhigh");
          break;
        case "setConfigOption":
          // A toggle's state travels as a bare boolean, a select's as its
          // value id, which is what the untagged Rust value serializes to.
          expect(cmd.configId).toBe("web_search");
          expect(cmd.value).toBe(true);
          break;
        default: {
          const never: never = cmd;
          throw new Error(`unhandled command variant: ${JSON.stringify(never)}`);
        }
      }
    }
  });

  // `extra` is how agent-specific data stays out of the neutral model, so it
  // has to survive the crossing intact rather than being flattened away.
  it("carries agent-specific data through extra", () => {
    const started = (goldenEvents as ChatEvent[]).find((e) => e.type === "sessionStarted");
    expect(started?.type === "sessionStarted" && started.extra?.ttftMs).toBe(1575);
  });

  it("separates turn-scoped events from session-scoped ones", () => {
    const byType = new Map((goldenEvents as ChatEvent[]).map((e) => [e.type, e]));
    expect(isTurnScoped(byType.get("textDelta")!)).toBe(true);
    expect(isTurnScoped(byType.get("turnCompleted")!)).toBe(true);
    // A permission prompt arrives on its own socket, outside any turn frame.
    expect(isTurnScoped(byType.get("permissionRequest")!)).toBe(false);
    // A question blocks a tool call, not a turn frame, so it carries no turnId
    // for the same reason a permission prompt does not.
    expect(isTurnScoped(byType.get("questionRequest")!)).toBe(false);
    expect(isTurnScoped(byType.get("sessionStarted")!)).toBe(false);
    expect(isTurnScoped(byType.get("rateLimit")!)).toBe(false);
  });

  // The nested half of the field-name check.
  //
  // The test above compares an event's own top-level keys, so renaming a field
  // *inside* `ChatQuestion` passes it untouched: the event still carries
  // `questions`, and nothing looks at what is in one. This walks the nested
  // objects in Rust's own samples and compares them against `CHAT_NESTED_KEYS`,
  // which `keysOf` pins to the TypeScript types. So a rename fails here from
  // Rust, and fails `tsc` from TypeScript.
  it("agrees with Rust on every field name nested inside a question", () => {
    const sorted = (o: object) => Object.keys(o).sort();
    const request = (goldenEvents as ChatEvent[]).find((e) => e.type === "questionRequest");
    expect(request?.type).toBe("questionRequest");
    if (request?.type !== "questionRequest") return;

    expect(request.questions.length).toBeGreaterThan(0);
    for (const question of request.questions) {
      expect(sorted(question)).toEqual([...CHAT_NESTED_KEYS.question].sort());
      expect(question.options.length).toBeGreaterThan(0);
      for (const option of question.options) {
        expect(sorted(option)).toEqual([...CHAT_NESTED_KEYS.questionOption].sort());
      }
    }

    const answer = (goldenCommands as ChatCommand[]).find((c) => c.type === "respondQuestion");
    expect(answer?.type).toBe("respondQuestion");
    if (answer?.type !== "respondQuestion") return;
    expect(answer.answers.length).toBeGreaterThan(0);
    for (const one of answer.answers) {
      expect(sorted(one)).toEqual([...CHAT_NESTED_KEYS.questionAnswer].sort());
    }
  });

  // And for the diff an expanded card is about to draw. Same reason as the
  // question and the summary: `toolCallCompleted`'s own key list stops at
  // `patch`, so nothing above this looks inside a hunk.
  it("agrees with Rust on every field name inside a patch hunk", () => {
    const sorted = (o: object) => Object.keys(o).sort();
    const done = (goldenEvents as ChatEvent[]).find((e) => e.type === "toolCallCompleted");
    expect(done?.type).toBe("toolCallCompleted");
    if (done?.type !== "toolCallCompleted") return;

    expect(done.patch.length).toBeGreaterThan(0);
    for (const hunk of done.patch) {
      expect(sorted(hunk)).toEqual([...CHAT_NESTED_KEYS.patchHunk].sort());
      // The markers ride on the lines rather than in a parallel array, which is
      // what lets one row type serve a measured patch and a computed one.
      expect(hunk.lines.every((l) => typeof l === "string")).toBe(true);
    }
  });

  // And for the quota windows the titlebar strip reads. `rateLimit`'s own key
  // list stops at `windows`, so a rename inside one would pass it untouched.
  it("agrees with Rust on every field name inside a usage window", () => {
    const sorted = (o: object) => Object.keys(o).sort();
    const rl = (goldenEvents as ChatEvent[]).find((e) => e.type === "rateLimit");
    expect(rl?.type).toBe("rateLimit");
    if (rl?.type !== "rateLimit") return;

    expect(rl.windows.length).toBeGreaterThan(0);
    for (const w of rl.windows) expect(sorted(w)).toEqual([...CHAT_NESTED_KEYS.usageWindow].sort());
  });

  // The same nested check, for the summary a collapsed row is about to read.
  //
  // `toolCallCompleted`'s own key list stops at `summary`, so nothing above
  // looks inside one. These walk Rust's own samples, one per variant, against a
  // `CHAT_NESTED_KEYS` entry per variant: renaming `hits` on either side fails
  // here, and naming a key that is not on the type fails `tsc`.
  it("agrees with Rust on every field name inside a tool summary", () => {
    const sorted = (o: object) => Object.keys(o).sort();
    const summaries = goldenToolSummaries as ToolSummary[];
    const keysFor: Record<ToolSummary["type"], readonly string[]> = {
      search: CHAT_NESTED_KEYS.toolSummarySearch,
      paths: CHAT_NESTED_KEYS.toolSummaryPaths,
      read: CHAT_NESTED_KEYS.toolSummaryRead,
      execute: CHAT_NESTED_KEYS.toolSummaryExecute,
      edit: CHAT_NESTED_KEYS.toolSummaryEdit,
      fetch: CHAT_NESTED_KEYS.toolSummaryFetch,
    };

    // Every variant is present, so a Rust sample that stopped being emitted
    // cannot leave its entry silently unchecked.
    expect(summaries.map((s) => s.type).sort()).toEqual(
      (Object.keys(keysFor) as ToolSummary["type"][]).sort(),
    );
    for (const summary of summaries) {
      expect(sorted(summary)).toEqual([...keysFor[summary.type]].sort());
    }
  });

  // Every sample carries the `Some` half of its optional fields, so the half
  // that actually ships is asserted here instead. Claude reports no exit code
  // at all, Grep's content mode reports no usable file count, a replayed read
  // knows no file length, and ACP publishes neither a status nor a byte count.
  // A mirror that typed any of these non-nullable would agree with the sample
  // and be wrong about the traffic.
  it("accepts the absent half of every optional summary field", () => {
    const absent: ToolSummary[] = [
      { type: "execute", exitCode: null, lines: 3 },
      { type: "search", hits: 2, files: null },
      { type: "read", lines: 13, from: 1, total: null },
      { type: "fetch", host: "example.com", status: null, bytes: null },
    ];
    const keysFor = {
      execute: CHAT_NESTED_KEYS.toolSummaryExecute,
      search: CHAT_NESTED_KEYS.toolSummarySearch,
      read: CHAT_NESTED_KEYS.toolSummaryRead,
      fetch: CHAT_NESTED_KEYS.toolSummaryFetch,
    } as const;
    for (const summary of absent) {
      const keys = keysFor[summary.type as keyof typeof keysFor];
      expect(Object.keys(summary).sort()).toEqual([...keys].sort());
    }
  });

  it("rejects junk rather than throwing", () => {
    expect(parseChatEvent(null)).toBeNull();
    expect(parseChatEvent("textDelta")).toBeNull();
    expect(parseChatEvent({})).toBeNull();
    expect(parseChatEvent({ type: "textDelta" })).toBeNull();
    expect(parseChatEvent({ type: "notAnEvent", sessionId: "s1" })).toBeNull();
  });
});
