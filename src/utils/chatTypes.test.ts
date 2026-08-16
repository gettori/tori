import { describe, it, expect } from "vitest";
import goldenEvents from "../../dev/fixtures/chat/events.json";
import goldenCommands from "../../dev/fixtures/chat/commands.json";
import {
  CHAT_COMMAND_KEYS,
  CHAT_COMMAND_TYPES,
  CHAT_EVENT_KEYS,
  CHAT_EVENT_TYPES,
  isTurnScoped,
  parseChatEvent,
  type ChatCommand,
  type ChatEvent,
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
          // than a claim; the summary is the harness's own words.
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

  // `extra` is how harness-specific data stays out of the neutral model, so it
  // has to survive the crossing intact rather than being flattened away.
  it("carries harness-specific data through extra", () => {
    const started = (goldenEvents as ChatEvent[]).find((e) => e.type === "sessionStarted");
    expect(started?.type === "sessionStarted" && started.extra?.ttftMs).toBe(1575);
  });

  it("separates turn-scoped events from session-scoped ones", () => {
    const byType = new Map((goldenEvents as ChatEvent[]).map((e) => [e.type, e]));
    expect(isTurnScoped(byType.get("textDelta")!)).toBe(true);
    expect(isTurnScoped(byType.get("turnCompleted")!)).toBe(true);
    // A permission prompt arrives on its own socket, outside any turn frame.
    expect(isTurnScoped(byType.get("permissionRequest")!)).toBe(false);
    expect(isTurnScoped(byType.get("sessionStarted")!)).toBe(false);
    expect(isTurnScoped(byType.get("rateLimit")!)).toBe(false);
  });

  it("rejects junk rather than throwing", () => {
    expect(parseChatEvent(null)).toBeNull();
    expect(parseChatEvent("textDelta")).toBeNull();
    expect(parseChatEvent({})).toBeNull();
    expect(parseChatEvent({ type: "textDelta" })).toBeNull();
    expect(parseChatEvent({ type: "notAnEvent", sessionId: "s1" })).toBeNull();
  });
});
