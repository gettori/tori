// Turning the backend's install route into something on screen.
//
// The routing decision belongs to the backend (`crate::install::install_route`),
// the only side that sees an adapter's `[install]` table. What lives here is
// what each rung does when the button is pressed, kept pure so it can be
// tested without a terminal - the same split as signIn.ts, for the same
// reasons.
//
// An install is a real PTY or it is nothing: vendor installers stream output,
// prompt, and fail in ways the user has to read. It runs as a **job**, which
// spawns the program directly and keeps the output on screen after a failing
// exit, so "npm: command not found" is readable instead of a surface that
// vanished.
import type { OpenJob } from "./events";

/** Mirrors `crate::install::InstallRoute`. */
export type InstallRoute = { type: "terminal"; program: string; args: string[] } | { type: "undeclared" };

/** The three things the `[install]` table can do to a binary. One job shape
 *  serves all of them; only the id and the title say which one is running. */
export type SetupVerb = "install" | "update" | "uninstall";

const VERB_TITLE: Record<SetupVerb, string> = {
  install: "Install",
  update: "Update",
  uninstall: "Uninstall",
};

/**
 * The job that runs one verb for one agent, or `null` for a route that runs
 * nothing.
 *
 * The id carries the verb and the adapter: unlike a login there is nothing
 * per-profile here, so pressing the button twice reveals the install already
 * running rather than racing two package managers over one global bin
 * directory.
 */
export function setupJob(
  verb: SetupVerb,
  agentId: string,
  agentLabel: string,
  route: InstallRoute,
  cwd: string,
): OpenJob | null {
  if (route.type !== "terminal") return null;
  return {
    id: `${verb}:${agentId}`,
    title: `${VERB_TITLE[verb]} ${agentLabel}`,
    cwd,
    program: route.program,
    args: route.args,
    // Vendor installers ask things (a sudo prompt, a version choice), so the
    // keyboard has to reach this one.
    interactive: true,
    // Both outcomes end the process, and both want a re-probe: a finished
    // install flips the card to Ready, and an abandoned one confirms it
    // did not.
    recheckAgentsOnExit: true,
  };
}

/**
 * What to tell the user for a route that runs nothing. `null` for the terminal
 * rung, which needs no explanation: the job is the explanation.
 */
export function installNote(agentLabel: string, program: string, route: InstallRoute): string | null {
  if (route.type === "terminal") return null;
  return `Tori has no install command for ${agentLabel}. Install ${program} yourself, then check again.`;
}
