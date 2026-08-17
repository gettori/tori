// Turning the backend's login route into something on screen.
//
// The routing decision itself belongs to the backend (`crate::auth::login_route`),
// which is the only side that can see an adapter's `[accounts]` table and its
// chat transport. What lives here is the other half: what each rung *does* when
// the button is pressed, kept pure so it can be tested without a terminal.
//
// The rung that matters most is `terminal`. Phase 0 measured that `claude auth
// login` is browser OAuth with no non-interactive variant and that `setup-token`
// is interactive too, so a login is a real PTY or it is nothing: anything that
// captured it would hang rather than fail. The tab therefore spawns the program
// directly (`kind: "command"`), which is also what keeps it on screen after the
// process exits, so a failed login is readable instead of a tab that vanished.
import type { OpenTerminal } from "./events";

/** Mirrors `crate::auth::LoginRoute`. */
export type LoginRoute =
  | { type: "terminal"; program: string; args: string[]; home: [string, string] | null }
  | { type: "agentStates" }
  | { type: "docs"; url: string };

/**
 * The tab that signs one profile in, or `null` for a route that opens no tab.
 *
 * `cwd` is where the tab starts. It has nothing to do with the login itself; a
 * terminal needs somewhere to be, and the folder the user is looking at is the
 * least surprising answer.
 *
 * The id carries the adapter and profile, so pressing "Sign in" twice for the
 * same account focuses the tab already doing it rather than starting a second
 * browser flow. Two different accounts get two different tabs, which is the
 * point: they are two logins.
 */
export function loginTab(
  agentId: string,
  agentLabel: string,
  profileId: string,
  profileLabel: string,
  route: LoginRoute,
  cwd: string,
): OpenTerminal | null {
  if (route.type !== "terminal") return null;
  return {
    id: `signin:${agentId}:${profileId}`,
    title: `Sign in to ${agentLabel} (${profileLabel})`,
    cwd,
    program: route.program,
    args: route.args,
    kind: "command",
    // The whole mechanism of a second account. Without it the agent writes
    // into the login the user already had, and Sway would show two profiles
    // that are one account.
    ...(route.home ? { env: { [route.home[0]]: route.home[1] } } : {}),
    // Both outcomes end the process, and both want a re-probe: a finished login
    // changes the answer, and an abandoned one confirms it did not.
    recheckAgentsOnExit: true,
  };
}

/**
 * What to tell the user for a route that opens no tab.
 *
 * `null` for the terminal rung, which needs no explanation: the tab is the
 * explanation.
 */
export function loginNote(agentLabel: string, route: LoginRoute): string | null {
  switch (route.type) {
    case "terminal":
      return null;
    // Not a shrug. The agent carries its own `authMethods` on the handshake, and
    // Sway relays their description text when a chat refuses to open; both
    // measured agents put a literal command there. Saying so beforehand beats a
    // button that would have to spawn the agent to find out.
    case "agentStates":
      return `${agentLabel} states how to sign in when you start a chat with it, in its own words.`;
    case "docs":
      return `Sway has no sign-in command for ${agentLabel}. Its adapter declares none.`;
  }
}
