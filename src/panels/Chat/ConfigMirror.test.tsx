import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { pointerClick } from "../../test/menus";
import ConfigMirror from "./ConfigMirror";
import { applyEvent, initialChat } from "./chatStore";
import type { ChatConfigOption } from "../../utils/chatTypes";

/** What `opencode acp` and `codex-acp` actually publish, plus the two rows this
 *  mirror exists for: a toggle with no category and a select with none. */
const OPTIONS: ChatConfigOption[] = [
  {
    id: "model",
    name: "Model",
    description: "",
    category: "model",
    kind: "select",
    current: "gpt-5.6-terra",
    choices: [{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "" }],
  },
  {
    id: "mode",
    name: "Mode",
    description: "",
    category: "mode",
    kind: "select",
    current: "agent",
    choices: [{ value: "agent", label: "Agent", description: "" }],
  },
  {
    id: "thought_level",
    name: "Reasoning effort",
    description: "",
    category: "thought_level",
    kind: "select",
    current: "medium",
    choices: [{ value: "medium", label: "Medium", description: "" }],
  },
  {
    id: "web_search",
    name: "Web search",
    description: "Let the agent search the web",
    category: "",
    kind: "boolean",
    value: false,
  },
  {
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
  },
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
      {
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
      },
    ]);
    const pill = getByLabelText("Verbosity");
    expect(pill.textContent).toContain("Detailed");
    const menu = openMenu(pill);
    // The choice the agent withdrew is gone, not merged in beside the new ones.
    expect(menu.textContent).not.toContain("Concise");
    expect(menu.textContent).toContain("Exhaustive");
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
