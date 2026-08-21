import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expectNoAxeViolations } from "../../test/axe";
import { pointerClick } from "../../test/menus";
import ConfigMirror from "./ConfigMirror";
import { applyEvent, initialChat } from "./chatStore";
import type { ChatConfigOption } from "../../utils/chatTypes";

/** What `opencode acp` and `codex-acp` actually publish, plus the two rows this
 *  mirror exists for: a toggle with no category and a select with none. */
/** Every option is one the agent says it can take unless a test says otherwise,
 *  which is what an ACP agent publishes: the protocol cannot say "refused". */
const live = <T extends object>(o: T) => ({ disabled: false, note: "", ...o });

const OPTIONS: ChatConfigOption[] = [
  live({
    id: "model",
    name: "Model",
    description: "",
    category: "model",
    kind: "select",
    current: "gpt-5.6-terra",
    choices: [{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "" }],
  }),
  live({
    id: "mode",
    name: "Mode",
    description: "",
    category: "mode",
    kind: "select",
    current: "agent",
    choices: [{ value: "agent", label: "Agent", description: "" }],
  }),
  live({
    id: "thought_level",
    name: "Reasoning effort",
    description: "",
    category: "thought_level",
    kind: "select",
    current: "medium",
    choices: [{ value: "medium", label: "Medium", description: "" }],
  }),
  live({
    id: "web_search",
    name: "Web search",
    description: "Let the agent search the web",
    category: "",
    kind: "boolean",
    value: false,
  }),
  live({
    id: "verbosity",
    name: "Verbosity",
    description: "",
    category: "",
    kind: "select",
    current: "concise",
    choices: [
      { value: "concise", label: "Concise", description: "Short answers" },
      { value: "detailed", label: "Detailed", description: "" },
    ],
  }),
];

function setup(options: ChatConfigOption[] = OPTIONS) {
  const onSet = vi.fn();
  const [live, setLive] = createSignal(options);
  const result = render(() => (
    <ConfigMirror options={live()} disabled={false} onSet={onSet} />
  ));
  const openMenu = (pill: HTMLElement) => {
    pointerClick(pill);
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const menu = menus[menus.length - 1];
    if (!menu) throw new Error("the pill opened no menu");
    return menu as HTMLElement;
  };
  const pick = (menu: HTMLElement, label: string) => {
    const row = [...menu.children].find(
      (r) => (r.firstElementChild?.firstElementChild as HTMLElement | null)?.textContent === label,
    );
    if (!row) throw new Error(`no row named ${label}`);
    pointerClick(row as HTMLElement);
  };
  return { ...result, onSet, setLive, openMenu, pick };
}

describe("the agent's own options in the composer bar", () => {
  it("shows only what Sway has no control of its own for", () => {
    const { container } = setup();
    // The three with bespoke pickers are not mirrored: two controls writing one
    // piece of session state is how they end up disagreeing about it.
    expect(container.textContent).not.toContain("Reasoning effort");
    expect(container.textContent).toContain("Web search");
    expect(container.textContent).toContain("Verbosity");
  });

  it("renders an uncategorized select as a menu, in the agent's own words", () => {
    const { getByLabelText, openMenu } = setup();
    const menu = openMenu(getByLabelText("Verbosity"));
    expect(menu.textContent).toContain("Concise");
    // The agent's own sentence about a choice, carried through rather than
    // dropped: Sway has nothing else to say about a lever it has never seen.
    expect(menu.textContent).toContain("Short answers");
  });

  it("sends the agent's own ids when a choice is picked", () => {
    const { getByLabelText, openMenu, pick, onSet } = setup();
    pick(openMenu(getByLabelText("Verbosity")), "Detailed");
    expect(onSet).toHaveBeenCalledWith("verbosity", "detailed");
  });

  it("sends a boolean as a boolean when the switch flips", () => {
    const { getByRole, onSet } = setup();
    fireEvent.click(getByRole("switch"));
    expect(onSet).toHaveBeenCalledWith("web_search", true);
  });

  /** The verify for "unknown option kinds are skipped, never crash the mirror".
   *  The protocol is `#[non_exhaustive]` on both sides, so a build older than
   *  the agent it is talking to is the normal case, not the exotic one. */
  it("skips a kind it cannot render and keeps the rest", () => {
    const novel = { id: "budget", name: "Budget", description: "", category: "", kind: "slider" };
    const { container } = setup([novel as unknown as ChatConfigOption, ...OPTIONS]);
    expect(container.textContent).not.toContain("Budget");
    expect(container.textContent).toContain("Web search");
  });

  /** Mid-session updates re-render, which is the half that cannot be faked: the
   *  agent answers every switch with its whole option set, and one option can
   *  re-cut another's choices. */
  it("follows the agent when it moves its own options", () => {
    const { getByLabelText, openMenu, setLive } = setup();
    setLive([
      live({
        id: "verbosity",
        name: "Verbosity",
        description: "",
        category: "",
        kind: "select",
        current: "detailed",
        choices: [
          { value: "detailed", label: "Detailed", description: "" },
          { value: "exhaustive", label: "Exhaustive", description: "" },
        ],
      }),
    ]);
    const pill = getByLabelText("Verbosity");
    expect(pill.textContent).toContain("Detailed");
    const menu = openMenu(pill);
    // The choice the agent withdrew is gone, not merged in beside the new ones.
    expect(menu.textContent).not.toContain("Concise");
    expect(menu.textContent).toContain("Exhaustive");
  });

  /** A row is keyed by the agent's own id, not by the option object. The whole
   *  set is replaced on every answer, so identity keying rebuilds the control
   *  the user is standing on and takes their focus with it. */
  it("keeps focus on a control while its own value moves under it", () => {
    const { getByRole, setLive } = setup();
    const sw = getByRole("switch") as HTMLElement;
    sw.focus();
    setLive(OPTIONS.map((o) => (o.id === "web_search" ? { ...o, kind: "boolean", value: true } : o)));

    expect(getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(getByRole("switch"));
  });

  it("swaps the widget when the agent changes a lever's shape", () => {
    const { getByRole, queryByRole, setLive } = setup();
    expect(queryByRole("switch")).not.toBeNull();
    setLive([
      live({
        id: "web_search",
        name: "Web search",
        description: "",
        category: "",
        kind: "select",
        current: "off",
        choices: [{ value: "off", label: "Off", description: "" }],
      }),
    ]);

    expect(queryByRole("switch")).toBeNull();
    expect(getByRole("button", { name: "Web search" })).toBeTruthy();
  });

  /** And the store is what feeds it, so the same rule holds end to end. */
  it("takes the whole set from the event rather than merging", () => {
    const s = initialChat("s1");
    applyEvent(s, { type: "configOptions", sessionId: "s1", options: OPTIONS });
    expect(s.configOptions).toHaveLength(5);
    applyEvent(s, {
      type: "configOptions",
      sessionId: "s1",
      options: [OPTIONS[3]],
    });
    expect(s.configOptions.map((o) => o.id)).toEqual(["web_search"]);
  });
});

// A lever the agent has and will not take. Rendered rather than hidden, because
// an absent control says nothing about why it is absent.
describe("a lever the agent published and refuses", () => {
  const REFUSED_TOGGLE: ChatConfigOption = {
    id: "fast_mode",
    name: "Fast mode",
    description: "Answer faster",
    category: "",
    disabled: true,
    note: "Fast mode is not available in the Agent SDK",
    kind: "boolean",
    value: false,
  };
  const REFUSED_SELECT: ChatConfigOption = {
    id: "verbosity",
    name: "Verbosity",
    description: "",
    category: "",
    disabled: true,
    note: "Not available on this model",
    kind: "select",
    current: "concise",
    choices: [{ value: "concise", label: "Concise", description: "" }],
  };

  it("says why in text anyone can see, not only on hover", () => {
    const { container } = setup([REFUSED_TOGGLE]);
    expect(container.textContent).toContain("Fast mode is not available in the Agent SDK");
  });

  // The note is only reachable while the control still takes focus, which a
  // bare `disabled` attribute would end.
  it("keeps the control focusable and points it at its own reason", () => {
    const { getByRole } = setup([REFUSED_TOGGLE]);
    const sw = getByRole("switch") as HTMLInputElement;

    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    const described = (sw.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("Fast mode is not available in the Agent SDK");
  });

  it("refuses the flip rather than moving and being corrected", () => {
    const { getByRole, onSet } = setup([REFUSED_TOGGLE]);
    fireEvent.click(getByRole("switch"));

    expect(onSet).not.toHaveBeenCalled();
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("passes the accessibility gate with both shapes refused", async () => {
    const { container } = setup([REFUSED_TOGGLE, REFUSED_SELECT]);
    await expectNoAxeViolations(container);
  });

  it("opens no menu on a refused pill, and still names its reason", () => {
    const { getByLabelText, container } = setup([REFUSED_SELECT]);
    const pill = getByLabelText("Verbosity");
    pointerClick(pill);

    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    expect((pill as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).toContain("Not available on this model");
  });
});
