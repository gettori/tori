import { invoke } from "@tauri-apps/api/core";
import { refreshAgentHealth } from "./agentHealth";
import type { OpenJob } from "./events";

type ExitEffects = Pick<OpenJob, "rediscoverOnExit" | "recheckAgentsOnExit" | "completeSignInOnExit">;

/** What a job asked to happen once its process ends. Shared by the dock's
 *  command tabs and first run's inline jobs, so a sign-in finishes the same
 *  way wherever it ran. Resolves once the agent re-probe has landed. */
export async function runExitEffects(job: ExitEffects, code: number | null): Promise<void> {
  if (job.rediscoverOnExit) invoke("rediscover").catch(() => {});
  // Only a clean exit: an abandoned login has no first run to finish.
  if (job.completeSignInOnExit && code === 0) {
    const { agentId, profileId } = job.completeSignInOnExit;
    invoke("complete_sign_in", { adapterId: agentId, profileId }).catch(() => {});
  }
  if (job.recheckAgentsOnExit) await refreshAgentHealth();
}
