import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@solidjs/testing-library";
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

/** Open a tooltip the way a keyboard user does. Kobalte opens on focus with no
 *  delay, so unlike the hover path this needs no timers - but it needs the real
 *  focus as well as the event. */
function focusTrigger(trigger: HTMLElement) {
  trigger.focus();
  fireEvent.focus(trigger);
}

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
    // Three, not two. A two-choice select is a toggle now (see the toggle
    // describe below), so the menu path needs a select that stays one.
    choices: [
      { value: "concise", label: "Concise", description: "Short answers" },
      { value: "detailed", label: "Detailed", description: "" },
      { value: "exhaustive", label: "Exhaustive", description: "" },
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
  it("shows only what Tori has no control of its own for", () => {
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
    // dropped: Tori has nothing else to say about a lever it has never seen.
    expect(menu.textContent).toContain("Short answers");
  });

  it("sends the agent's own ids when a choice is picked", () => {
    const { getByLabelText, openMenu, pick, onSet } = setup();
    pick(openMenu(getByLabelText("Verbosity")), "Detailed");
    expect(onSet).toHaveBeenCalledWith("verbosity", "detailed");
  });

  it("sends a boolean as a boolean when the toggle flips", () => {
    const { getByLabelText, onSet } = setup();
    fireEvent.click(getByLabelText("Web search"));
    expect(onSet).toHaveBeenCalledWith("web_search", true);
  });

  /** A lever Tori has no glyph for keeps its name on screen. The icon-only pill
   *  is for the handful whose picture already says it; a generic toggle glyph
   *  with no words is a control the user cannot identify at all. */
  it("draws the name of a toggle whose glyph means nothing", () => {
    const { getByLabelText } = setup();
    expect(getByLabelText("Web search").textContent).toContain("Web search");
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
          { value: "terse", label: "Terse", description: "" },
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
    const { getByLabelText, setLive } = setup();
    const toggle = getByLabelText("Web search") as HTMLElement;
    toggle.focus();
    setLive(OPTIONS.map((o) => (o.id === "web_search" ? { ...o, kind: "boolean", value: true } : o)));

    expect(getByLabelText("Web search").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(getByLabelText("Web search"));
  });

  it("swaps the widget when the agent changes a lever's shape", () => {
    const { getByLabelText, setLive } = setup();
    expect(getByLabelText("Web search").getAttribute("aria-pressed")).toBe("false");
    setLive([
      live({
        id: "web_search",
        name: "Web search",
        description: "",
        category: "",
        kind: "select",
        current: "off",
        choices: [
          { value: "off", label: "Off", description: "" },
          { value: "fast", label: "Fast", description: "" },
          { value: "deep", label: "Deep", description: "" },
        ],
      }),
    ]);

    // A menu pill now: no pressed state, and a caret it can be opened by.
    const pill = getByLabelText("Web search");
    expect(pill.getAttribute("aria-pressed")).toBeNull();
    expect(pill.getAttribute("aria-haspopup")).toBe("menu");
  });

  /**
   * A select with exactly two choices is a two-state lever, whatever the agent
   * called it, so it renders as one control rather than as a menu that opens to
   * offer a bit. **The second choice is "on"**: a select carries no polarity, so
   * the only thing to go on is the order the agent listed them in, and agents
   * list the default first.
   */
  it("renders a two-choice select as a toggle, second choice on", () => {
    const two = live({
      id: "collaboration_mode",
      name: "Collaboration mode",
      description: "",
      category: "",
      kind: "select",
      current: "default",
      choices: [
        { value: "default", label: "Default", description: "" },
        { value: "plan", label: "Plan", description: "" },
      ],
    }) as ChatConfigOption;

    const { getByLabelText, onSet } = setup([two]);
    const pill = getByLabelText("Collaboration mode: Default");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    // It commits with the agent's own value id, not a boolean: sending the
    // wrong shape is the one thing an agent answers by doing nothing.
    fireEvent.click(pill);
    expect(onSet).toHaveBeenCalledWith("collaboration_mode", "plan");
  });

  it("says what pressing a toggle does, in the agent's own choice labels", () => {
    const two = live({
      id: "collaboration_mode",
      name: "Collaboration mode",
      description: "How codex collaborates on a task",
      category: "",
      kind: "select",
      current: "default",
      choices: [
        { value: "default", label: "Default", description: "" },
        { value: "plan", label: "Plan", description: "" },
      ],
    }) as ChatConfigOption;

    const { getByLabelText } = setup([two]);
    focusTrigger(getByLabelText("Collaboration mode: Default"));

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Switch to Plan");
    expect(tip.textContent).not.toContain("How codex collaborates");
  });

  it("turns the action round once the toggle is on", () => {
    const two = live({
      id: "collaboration_mode",
      name: "Collaboration mode",
      description: "",
      category: "",
      kind: "select",
      current: "plan",
      choices: [
        { value: "default", label: "Default", description: "" },
        { value: "plan", label: "Plan", description: "" },
      ],
    }) as ChatConfigOption;

    const { getByLabelText } = setup([two]);
    focusTrigger(getByLabelText("Collaboration mode: Plan"));
    expect(screen.getByRole("tooltip").textContent).toBe("Switch to Default");
  });

  it("shows the second choice as pressed when it is the one in force", () => {
    const two = live({
      id: "collaboration_mode",
      name: "Collaboration mode",
      description: "",
      category: "",
      kind: "select",
      current: "plan",
      choices: [
        { value: "default", label: "Default", description: "" },
        { value: "plan", label: "Plan", description: "" },
      ],
    }) as ChatConfigOption;

    const { getByLabelText, onSet } = setup([two]);
    const pill = getByLabelText("Collaboration mode: Plan");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pill);
    expect(onSet).toHaveBeenCalledWith("collaboration_mode", "default");
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

  /**
   * **The reason is a tooltip, not a line in the bar.**
   *
   * It used to be drawn beside the pill, on the argument that a reason only a
   * screen reader can hear leaves everyone else with a dead control. Right about
   * the reason, wrong about where: a full sentence of prose parked permanently
   * in a row of one-word pills is the composer explaining its plumbing while
   * nothing has failed. The pill still shows that it is refusing; the sentence
   * moved one hover away, and `aria-disabled` is what makes it findable.
   */
  it("carries its reason in the tooltip rather than as a line in the bar", () => {
    const { container, getByLabelText } = setup([REFUSED_TOGGLE]);
    expect(container.textContent).not.toContain(REFUSED_TOGGLE.note);
    expect(getByLabelText("Fast mode").getAttribute("aria-disabled")).toBe("true");
  });

  it("says why on hover, in the agent's own words after its description", () => {
    const { getByLabelText } = setup([REFUSED_TOGGLE]);
    focusTrigger(getByLabelText("Fast mode"));

    // `screen`, not the render result: a tooltip portals onto the body, which
    // is outside the container the query helpers are scoped to.
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Answer faster");
    expect(tip.textContent).toContain(REFUSED_TOGGLE.note);
  });

  // Refusing, not disabled: a bare `disabled` takes the control out of the tab
  // order and the tooltip carrying its reason out of reach with it.
  it("keeps the control focusable", () => {
    const { getByLabelText } = setup([REFUSED_TOGGLE]);
    const pill = getByLabelText("Fast mode") as HTMLButtonElement;

    expect(pill.disabled).toBe(false);
    expect(pill.getAttribute("aria-disabled")).toBe("true");
  });

  it("refuses the flip rather than moving and being corrected", () => {
    const { getByLabelText, onSet } = setup([REFUSED_TOGGLE]);
    fireEvent.click(getByLabelText("Fast mode"));

    expect(onSet).not.toHaveBeenCalled();
    expect(getByLabelText("Fast mode").getAttribute("aria-pressed")).toBe("false");
  });

  it("passes the accessibility gate with both shapes refused", async () => {
    const { container } = setup([REFUSED_TOGGLE, REFUSED_SELECT]);
    await expectNoAxeViolations(container);
  });

  it("opens no menu on a refused pill, and still names its reason", () => {
    const { getByLabelText } = setup([REFUSED_SELECT]);
    const pill = getByLabelText("Verbosity");
    pointerClick(pill);

    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    expect((pill as HTMLButtonElement).disabled).toBe(false);

    focusTrigger(pill);
    expect(screen.getByRole("tooltip").textContent).toContain("Not available on this model");
  });
});
