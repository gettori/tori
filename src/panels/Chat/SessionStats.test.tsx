import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import SessionStats, { type SessionDetail } from "./SessionStats";
import { __resetModelCapsForTests } from "../../utils/modelCaps";
import { contextWindowFor, pickableModels } from "../../utils/chatModels";
import type { ChatConfig } from "../../utils/agents";
import type { ChatModelInfo } from "../../utils/chatTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
const invoked = vi.mocked(invoke);

const detail = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  prompt_count: 3,
  turn_count: 4,
  tool_count: 5,
  output_tokens: 100,
  context_tokens: 50_000,
  model: "claude-sonnet-5",
  compaction_count: 0,
  compaction_reclaimed: 0,
  touched_count: 0,
  ...over,
});

function adapter(): ChatConfig {
  return {
    transport: "claude_stream_json",
    program: "claude",
    base_args: [],
    session_id_args: [],
    resume_args: [],
    model_args: [],
    effort_args: [],
    mode_args: [],
    add_dir_args: [],
    models: [
      {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        context_window: 1_000_000,
        effort_levels: [],
        supports_thinking: true,
        supports_images: true,
      },
    ],
    modes: [],
    effort: [],
  };
}

describe("SessionStats", () => {
  beforeEach(() => {
    invoked.mockReset();
    // The caps latch is module state that outlives a test; without this the
    // second test to want caps never calls out and the assertions below become
    // claims about test ordering.
    __resetModelCapsForTests();
  });

  it("renders the window it was given, not one of its own", () => {
    const { container } = render(() => <SessionStats detail={detail()} contextWindow={1_000_000} />);
    expect(container.textContent).toContain("50k/1.0M");
  });

  // The figure people actually read at a glance, beside the tokens it is
  // derived from rather than instead of them.
  it("shows the share of the window in brackets", () => {
    const { container } = render(() => <SessionStats detail={detail()} contextWindow={200_000} />);
    expect(container.textContent).toContain("50k/200k (25%)");
  });

  // The failure this phase exists to end: nothing knows the window, so the
  // strip used to fall back to a family guess and draw a denominator anyway.
  it("shows no context stat at all when no source knows the window", () => {
    const { container } = render(() => (
      <SessionStats detail={detail({ model: "claude-sonnet-5" })} contextWindow={null} />
    ));
    expect(container.textContent).not.toContain("50k/");
    // The other figures still render; only the context stat is withheld.
    expect(container.textContent).toContain("3");
  });

  // A meter reading 187% is the symptom that started this. Usage above the
  // window means the window is wrong, so the gauge draws empty and the title
  // says so rather than clamping to a full bar.
  it("renders no percentage when usage contradicts the window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(() => (
      <SessionStats detail={detail({ context_tokens: 374_000 })} contextWindow={200_000} />
    ));
    const stat = [...container.querySelectorAll("span")].find((s) => s.title.startsWith("Context:"));
    expect(stat?.title).toContain("window unknown");
    expect(stat?.title).not.toContain("187%");
    // Withheld alongside the gauge: a percentage above 100 is the claim this
    // guard exists to refuse, so it must not reappear in the brackets.
    expect(container.textContent).not.toContain("%");
    warn.mockRestore();
  });

  // The claim the lazy fetch exists to make checkable. It used to fire from
  // StatusStrip's body on every mount, so "no network call for a Claude
  // session" passed by construction rather than by behaviour. Asserted against
  // the resolver, which is the only thing that reaches the catalogue now.
  it("makes no context-caps call for a Claude session", () => {
    contextWindowFor(adapter(), "claude-sonnet-5", { "claude-sonnet-5": 1_000_000 });
    contextWindowFor(adapter(), "claude-opus-5", {});
    contextWindowFor(null, "claude-fable-5", {});
    render(() => <SessionStats detail={detail()} contextWindow={1_000_000} />);
    expect(invoked).not.toHaveBeenCalled();
  });

  it("still reaches for OpenRouter when a non-Claude model has no closer source", () => {
    expect(contextWindowFor(null, "qwen3-6-plus", {})).toBe(1_000_000);
    expect(invoked).toHaveBeenCalledWith("model_context_caps");
  });
});

describe("one model, one denominator", () => {
  // The composer meter reads `PickableModel.contextWindow`; the strip is handed
  // the same value. Asserting they agree is the only thing that keeps the two
  // surfaces from drifting back apart, which is how one model came to render
  // 200k in the composer and 1M in the strip.
  it("gives the composer and the strip the same number", () => {
    const live: ChatModelInfo[] = [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsAutoMode: true,
      },
    ];
    const reported = { "claude-sonnet-5": 1_000_000 };
    const composer = pickableModels(live, adapter(), reported)[0].contextWindow;
    const strip = contextWindowFor(adapter(), "claude-sonnet-5", reported);

    expect(composer).toBe(1_000_000);
    expect(strip).toBe(composer);

    const { container } = render(() => <SessionStats detail={detail()} contextWindow={strip} />);
    expect(container.textContent).toContain("1.0M");
  });
});
