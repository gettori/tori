// The mode an agent reads in without stopping to ask, for a session nobody
// watches. An agent missing here spawns on its usual pick.
const READ_ONLY_MODE: Record<string, string> = { claude: "plan" };

export function spawnMode(asked: string | null, readOnly: boolean, agentId: string): string | null {
  return asked ?? (readOnly ? (READ_ONLY_MODE[agentId] ?? null) : null);
}
