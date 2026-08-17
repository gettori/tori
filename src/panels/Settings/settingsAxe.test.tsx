// The accessibility gate for the Settings panel.
//
// The panel had none until the rail landed, which is the wrong way round: it is
// the app's densest screen of controls, it is a modal claiming `aria-modal`, and
// the redesign rebuilt every control on it. A switch is a restyled checkbox, a
// stepper is two buttons around a number field, and the rail is a vertical
// tablist - three shapes where an accessible name is easy to leave out and
// impossible to notice by eye.
//
// **Body-scoped**, because the panel is a `<Portal>`: it mounts as a sibling of
// the container `render` returns, so a container-scoped run would audit an empty
// div and pass. See `src/test/axe.ts`.
//
// The three states are here rather than one, because a run only ever sees the
// configuration its fixture builds: the default category, a search (which
// un-hides all six panes at once and is the only state with no selected tab),
// and a category whose rows are steppers and selects rather than switches.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));


import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings } from "./settingsStore";
import { expectNoAxeViolations } from "../../test/axe";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) =>
      cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS,
  );
  await loadWorkspaceSettings(null);
});

const type = (q: string) =>
  fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: q } });

describe("the Settings panel's accessibility", () => {
  it("passes on the category it opens to", async () => {
    render(() => <Settings onClose={() => {}} />);
    await expectNoAxeViolations(document.body);
  });

  it("passes on a category of steppers and selects", async () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Appearance/ }));
    await expectNoAxeViolations(document.body);
  });

  it("passes on a category of switches", async () => {
    // Editor is the fixture that matters most and the easiest to leave out: a
    // switch is an `appearance: none` checkbox whose visible text sits in a
    // sibling `<label>` with no `for`, so its accessible name comes from an
    // `aria-label` and nothing on screen would look wrong without one. The first
    // three cases here rendered no switch at all, and the gate was green about a
    // panel where every one of them was nameless.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
    await expectNoAxeViolations(document.body);
  });

  it("passes on a category of mixed controls", async () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Chat/ }));
    await expectNoAxeViolations(document.body);
  });

  // The default fixture's `agent_health` falls through to a settings object, so
  // the guard empties the groups and the first case audits a Agents pane with
  // no agents in it. This is the one that actually renders a card, and then
  // the page behind it.
  it("passes on a agent card and the page it opens", async () => {
    invoke.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "agent_health")
          return [
            {
              id: "claude",
              label: "Claude",
              program: "claude",
              status: "versionDrift",
              signIn: "signedIn",
              account: "a@b.c",
              apiKeySource: null,
              path: "/usr/bin/claude",
              version: "2.1.232",
              verifiedAgainst: "claude 2.1.231",
              sessionsDir: "/home/me/.claude/projects",
              sessionsDirExists: true,
              hooks: true,
              needsYou: true,
              overridePath: null,
            },
          ];
        if (cmd === "agent_accounts")
          return { adapterId: "claude", declared: true, canAdd: true, canSignOut: true, profiles: [] };
        return cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS;
      },
    );
    render(() => <Settings onClose={() => {}} />);
    const card = await screen.findByRole("button", { name: /Claude/ });
    await expectNoAxeViolations(document.body);

    fireEvent.click(card);
    await screen.findByText("Chat capabilities");
    await expectNoAxeViolations(document.body);
  });

  it("passes while results are showing across every category", async () => {
    // The state with six visible tabpanels and no selected tab, which is the one
    // an ARIA rule is most likely to object to.
    render(() => <Settings onClose={() => {}} />);
    type("font");
    expect(document.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
    await expectNoAxeViolations(document.body);
  });
});
