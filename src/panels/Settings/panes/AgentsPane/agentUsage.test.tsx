// The Usage block on an agent's own page, end to end through the panel.
//
// Two things are being held here. **A rung Sway has no read path for is shown
// and refused**, not hidden, so the ladder reads as a ladder and a user can see
// what is coming; and **the threshold is read-only**, because one number governs
// Sway's own ceilings and every agent's quota windows, so a second control for
// it here would be a second way to move one value.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { DEFAULT_SETTINGS, loadSettings } from "../../settingsStore";
import { ensureAdaptersLoaded } from "../../../../utils/agents";
import { __resetModelCatalogsForTests } from "../../../../utils/modelCatalog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

// `ensureAdaptersLoaded` keeps its one answer for the life of the module, which
// is right in the app and wrong for a file whose tests each want a different
// ladder. Only the resolution is stood in for; what the block does with the
// answer is what these tests are about.
const ladder = vi.hoisted(() => ({
  usage: null as { sources: string[] } | null,
  reason: null as string | null,
}));
vi.mock("../../../../utils/agents", async (orig) => {
  const actual = await orig<typeof import("../../../../utils/agents")>();
  return {
    ...actual,
    findAdapter: (id: string) => ({
      ...actual.findAdapter(id),
      usage: ladder.usage,
      usage_reason: ladder.reason,
    }),
  };
});

/** `settings` is a Solid store **over `DEFAULT_SETTINGS` itself**, so every write
 *  the panel makes mutates it in place and the next test would start on the last
 *  one's answers. Snapshotted once, the way `prefsCommands.test.tsx` does. */
const PRISTINE = structuredClone(DEFAULT_SETTINGS);

/** What the settings file holds right now, so a write is readable back. */
let stored: Record<string, unknown>;
/** Every settings object the panel wrote, newest last. */
let writes: Record<string, unknown>[];

const health = () => ({
  id: "claude",
  label: "Claude",
  program: "claude",
  status: "versionMatch",
  signIn: "signedIn",
  account: "me@example.com",
  apiKeySource: null,
  path: "/usr/bin/claude",
  version: "2.1.231",
  verifiedAgainst: "claude 2.1.231",
  sessionsDir: "/home/me/.claude/projects",
  sessionsDirExists: true,
  hooks: true,
  needsYou: true,
  overridePath: null,
});

const profile = (over: Record<string, unknown> = {}) => ({
  id: "default",
  label: "Default",
  isDefault: true,
  home: null,
  signIn: "signedIn",
  account: "me@example.com",
  apiKeySource: null,
  duplicateOf: null,
  login: { type: "terminal", program: "claude", args: ["auth", "login"], home: null },
  ...over,
});

/** Claude as the loader resolves it: one declared rung, the other two not built
 *  for it yet. */
const adapter = (usage: unknown, reason: string | null = null) => ({
  id: "claude",
  label: "Claude",
  icon: "claude",
  program: "claude",
  base_args: [],
  yolo_args: [],
  resume_args: ["--resume", "{id}"],
  parser_kind: "claude_jsonl",
  running_pattern: "claude {id}",
  pty_quiet_ms: 2000,
  chat: null,
  accounts: null,
  usage,
  usage_reason: reason,
});

async function mount(
  over: { usage?: unknown; reason?: string | null; profiles?: Record<string, unknown>[] } = {},
) {
  invoked.mockReset();
  __resetModelCatalogsForTests();
  stored = structuredClone(PRISTINE) as unknown as Record<string, unknown>;
  // Claude switched on, which the built-in defaults do not do. The usage block
  // is reachable either way, but a read is gated on the agent being enabled, so
  // without this the probe test would pass for the wrong reason.
  (stored.agent as { enabled: Record<string, boolean> }).enabled = { claude: true };
  writes = [];
  invoked.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health()];
    if (cmd === "agent_accounts")
      return {
        adapterId: "claude",
        declared: true,
        canAdd: true,
        canSignOut: true,
        profiles: over.profiles ?? [profile()],
      };
    if (cmd === "list_agents")
      return [adapter("usage" in over ? over.usage : { sources: ["sessions"] }, over.reason ?? null)];
    if (cmd === "get_settings") return stored;
    if (cmd === "set_settings") {
      stored = (args as { settings: Record<string, unknown> }).settings;
      writes.push(stored);
      return stored;
    }
    if (cmd === "agent_login_route")
      return { type: "terminal", program: "claude", args: ["auth", "login"], home: null };
    return [];
  });
  ladder.usage = "usage" in over ? (over.usage as { sources: string[] } | null) : { sources: ["sessions"] };
  ladder.reason = over.reason ?? null;
  await ensureAdaptersLoaded();
  await loadSettings();
  const r = render(() => <AgentsSection />);
  const card = await r.findByRole("button", { name: /Claude/ });
  fireEvent.click(card);
  await waitFor(() => expect(r.container.textContent).toContain("Chat capabilities"));
  return r;
}

/** The usage block the panel wrote, resolved from the newest settings write. */
const savedUsage = () =>
  (writes[writes.length - 1]?.agent as { usage?: Record<string, unknown> } | undefined)?.usage;

const radio = (name: string | RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;

beforeEach(() => {
  invoked.mockReset();
});

describe("the source radio", () => {
  it("offers every rung and refuses the ones with no read path", async () => {
    await mount();

    expect(radio("Off").disabled).toBe(false);
    expect(radio(/^Sessions/).disabled).toBe(false);
    expect(radio(/^CLI/).disabled).toBe(true);
    expect(radio(/^Account token/).disabled).toBe(true);
    // Refused, and each one says why rather than leaving the reader guessing.
    expect(screen.getAllByText(/Not built for Claude yet/)).toHaveLength(2);
  });

  // No entry is not "off": an agent nobody has answered for takes the first
  // rung its adapter declares, which is a reading that costs nothing.
  it("starts on the adapter's first declared rung with nothing stored", async () => {
    await mount();
    expect(radio(/^Sessions/).checked).toBe(true);
    expect(radio("Off").checked).toBe(false);
  });

  it("writes the answer", async () => {
    await mount();
    fireEvent.click(radio("Off"));
    await waitFor(() => expect(savedUsage()).toBeTruthy());
    expect((savedUsage()!.claude as { source: string }).source).toBe("off");
  });

  // Codex's shape after Phase 3: one rung, and it is not the first one on the
  // ladder. What is offered has to follow the adapter rather than the order.
  it("enables whichever rungs the adapter declared, not the ones above them", async () => {
    await mount({ usage: { sources: ["cli"] } });

    expect(radio(/^CLI/).disabled).toBe(false);
    expect(radio(/^CLI/).checked).toBe(true);
    expect(radio(/^Sessions/).disabled).toBe(true);
    expect(radio(/^Account token/).disabled).toBe(true);
  });

  // Claude after Phase 4: the token rung is real, and the copy has to name what
  // it costs. Measured 2026-09-06: macOS binds the allow to the exact binary, so
  // an unsigned build asks again after every update.
  it("says what the account token rung costs before it is switched on", async () => {
    await mount({ usage: { sources: ["sessions", "token"] } });

    const copy = screen.getByText(/login Keychain/);
    expect(copy.textContent).toMatch(/macOS will ask/);
    expect(copy.textContent).toMatch(/until Sway next updates/);
    expect(radio(/^Account token/).disabled).toBe(false);
  });

  // The prompt has to follow the click. A read deferred to a background tick
  // raises a Keychain dialog minutes later, which nobody connects to what they
  // did in Settings.
  it("reads immediately when the token rung is switched on, and never while it is off", async () => {
    await mount({ usage: { sources: ["sessions", "token"] } });
    expect(invoked.mock.calls.filter(([c]) => c === "usage_token_claude")).toHaveLength(0);

    fireEvent.click(radio(/^Account token/));
    await waitFor(() =>
      expect(invoked.mock.calls.filter(([c]) => c === "usage_token_claude")).toHaveLength(1),
    );
  });

  it("is refused whole, with the loader's own reason, for an adapter with no ladder", async () => {
    await mount({ usage: null, reason: "this adapter predates the usage table (schema 4)" });

    expect(radio("Off").disabled).toBe(true);
    expect(screen.getByText(/predates the usage table/)).toBeTruthy();
  });
});

describe("the other controls", () => {
  it("writes the detail level", async () => {
    await mount();

    const trigger = screen.getByRole("button", { name: /Usage detail/ });
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    const full = screen.getByRole("option", { name: "Full" });
    fireEvent.pointerDown(full, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(full, { pointerType: "mouse", button: 0 });
    fireEvent.click(full);
    await waitFor(() => expect(savedUsage()).toBeTruthy());
    expect((savedUsage()!.claude as { detail: string }).detail).toBe("full");
  });

  it("writes the notify answer, which starts on", async () => {
    await mount();

    const toggle = screen.getByRole("switch", { name: /Notify about Claude quota/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(savedUsage()).toBeTruthy());
    expect((savedUsage()!.claude as { notify: boolean }).notify).toBe(false);
  });

  // One number, one control. A copy here would be a second way to move it and
  // a reader would not know which one won.
  it("shows the shared threshold as a value and points at its one control", async () => {
    await mount();

    const row = document.getElementById("settings-row-usage-warn-at")!;
    expect(row.textContent).toContain("80%");
    expect(row.textContent).toContain("Chat");
    expect(row.querySelector("input")).toBeNull();
  });
});

describe("which accounts reach the titlebar", () => {
  const second = { ...profile({ id: "work", label: "Work", isDefault: false, home: "/home/me/.sway/claude/work" }) };

  it("offers the control on a named account and never on the default one", async () => {
    await mount({ profiles: [profile(), second] });
    // eslint-disable-next-line no-console

    expect(screen.getByRole("checkbox", { name: "Show Work in the titlebar" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Show Default in the titlebar" })).toBeNull();
  });

  it("hides the account it is unticked on", async () => {
    await mount({ profiles: [profile(), second] });

    fireEvent.click(screen.getByRole("checkbox", { name: "Show Work in the titlebar" }));
    await waitFor(() => expect(savedUsage()).toBeTruthy());
    expect((savedUsage()!.claude as { hiddenProfiles: string[] }).hiddenProfiles).toEqual(["work"]);
  });

  it("offers nothing to hide when Sway can read no quota for the agent", async () => {
    await mount({ usage: null, reason: "this adapter declares no usage source", profiles: [profile(), second] });

    expect(screen.queryByRole("checkbox", { name: "Show Work in the titlebar" })).toBeNull();
  });
});
