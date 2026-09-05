// What each rung of the login ladder actually does on screen.
//
// The routing decision (which rung) is the backend's and is tested there. What
// is tested here is the half that can go wrong silently: a login tab that
// forgets to carry the profile's home signs the user into the account they
// already had, reports success, and leaves two profiles that are one account.
import { describe, it, expect } from "vitest";
import { loginJob, loginNote, type LoginRoute } from "./signIn";

const terminal = (home: [string, string] | null): LoginRoute => ({
  type: "terminal",
  program: "claude",
  args: ["auth", "login"],
  home,
});

describe("the terminal rung", () => {
  // The whole mechanism of a second account. Phase 0 measured that `claude`
  // derives its Keychain service from this variable's value, so a tab spawned
  // without it writes into the default account's credentials.
  it("carries the profile's home variable into the tab", () => {
    const tab = loginJob(
      "claude",
      "Claude",
      "work",
      "Work",
      terminal(["CLAUDE_CONFIG_DIR", "/canonical/work"]),
      "/home/me",
    );
    expect(tab?.env).toEqual({ CLAUDE_CONFIG_DIR: "/canonical/work" });
    expect(tab?.program).toBe("claude");
    expect(tab?.args).toEqual(["auth", "login"]);
  });

  // The default profile *is* the variable left unset. Setting it to anything at
  // all, including an empty string, would sign the user in somewhere else.
  it("sets no environment at all for the default profile", () => {
    const tab = loginJob("claude", "Claude", "default", "Default", terminal(null), "/home/me");
    expect(tab?.env).toBeUndefined();
  });

  // A login is browser OAuth with no non-interactive variant, so it has to be a
  // real process the user can see and type into. Declaring it interactive is
  // what takes the window to Shells and puts the cursor in its tab.
  it("takes the keyboard, because the flow has to be typed at", () => {
    const tab = loginJob("claude", "Claude", "work", "Work", terminal(null), "/home/me");
    expect(tab?.interactive).toBe(true);
  });

  // Both outcomes end the process. A finished login changes the answer; an
  // abandoned one confirms it did not, which is cheap and keeps the state from
  // going stale after a cancel.
  it("re-probes on exit, whether the login finished or was abandoned", () => {
    const tab = loginJob("claude", "Claude", "work", "Work", terminal(null), "/home/me");
    expect(tab?.recheckAgentsOnExit).toBe(true);
  });

  // Pressing "Sign in" twice for one account should focus the tab already doing
  // it, not start a second browser flow. Two accounts are two logins and get
  // two tabs.
  it("gives one tab per account, not per press", () => {
    const one = loginJob("claude", "Claude", "work", "Work", terminal(null), "/home/me");
    const again = loginJob("claude", "Claude", "work", "Work", terminal(null), "/home/me");
    const other = loginJob("claude", "Claude", "personal", "Personal", terminal(null), "/home/me");
    expect(one?.id).toBe(again?.id);
    expect(one?.id).not.toBe(other?.id);
  });
});

describe("the rungs that open no tab", () => {
  it("opens nothing and says why for an agent that states its own method", () => {
    const route: LoginRoute = { type: "agentStates" };
    expect(loginJob("opencode", "OpenCode", "default", "Default", route, "/")).toBeNull();
    expect(loginNote("OpenCode", route)).toContain("OpenCode");
  });

  it("opens nothing and says why when the adapter declares no sign-in", () => {
    const route: LoginRoute = { type: "docs", url: "https://example.invalid/adapters" };
    expect(loginJob("thing", "Thing", "default", "Default", route, "/")).toBeNull();
    expect(loginNote("Thing", route)).toContain("Thing");
  });

  // The tab is the explanation, so a note beside it would be noise.
  it("adds no note to the rung that opens a terminal", () => {
    expect(loginNote("Claude", terminal(null))).toBeNull();
  });
});
