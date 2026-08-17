// Turning the backend's install route into something on screen.
//
// The routing decision belongs to the backend (`crate::install::install_route`),
// the only side that sees an adapter's `[install]` table. What lives here is
// what each rung does when the button is pressed, kept pure so it can be
// tested without a terminal - the same split as signIn.ts, for the same
// reasons.
//
// An install is a real PTY tab or it is nothing: vendor installers stream
// output, prompt, and fail in ways the user has to read. The tab spawns the
// program directly (`kind: "command"`), which keeps it on screen after the
// process exits, so "npm: command not found" is readable instead of a tab
// that vanished.
import type { OpenTerminal } from "./events";

/** Mirrors `crate::install::InstallRoute`. */
export type InstallRoute =
  | { type: "terminal"; program: string; args: string[] }
  | { type: "undeclared" };

/** The three things the `[install]` table can do to a binary. One tab shape
 *  serves all of them; only the id and the title say which one is running. */
export type SetupVerb = "install" | "update" | "uninstall";

const VERB_TITLE: Record<SetupVerb, string> = {
  install: "Install",
  update: "Update",
  uninstall: "Uninstall",
};

/**
 * The tab that runs one verb for one agent, or `null` for a route that opens
 * no tab.
 *
 * The id carries the verb and the adapter: unlike a login there is nothing
 * per-profile here, so pressing the button twice focuses the tab already doing
 * it rather than racing two package managers over one global bin directory.
 */
export function setupTab(
  verb: SetupVerb,
  agentId: string,
  agentLabel: string,
  route: InstallRoute,
  cwd: string,
): OpenTerminal | null {
  if (route.type !== "terminal") return null;
  return {
    id: `${verb}:${agentId}`,
    title: `${VERB_TITLE[verb]} ${agentLabel}`,
    cwd,
    program: route.program,
    args: route.args,
    kind: "command",
    // Both outcomes end the process, and both want a re-probe: a finished
    // install flips the card to Ready, and an abandoned one confirms it
    // did not.
    recheckAgentsOnExit: true,
  };
}

/**
 * What to tell the user for a route that opens no tab. `null` for the
 * terminal rung, which needs no explanation: the tab is the explanation.
 */
export function installNote(agentLabel: string, program: string, route: InstallRoute): string | null {
  if (route.type === "terminal") return null;
  return `Sway has no install command for ${agentLabel}. Install ${program} yourself, then check again.`;
}
