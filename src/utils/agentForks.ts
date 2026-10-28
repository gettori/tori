import { findAdapter } from "./agents";
import { chatTier } from "./chatCapabilities";
import { catalogFor } from "./modelCatalog";

// Claude forks by its transport, which Tori measured. An ACP agent forks only
// if it said so on a handshake Tori has cached, since the verb is unstable in
// the protocol and agents differ.
export function canFork(agent: string, profile: string | null): boolean {
  const transport = findAdapter(agent).chat?.transport;
  if (chatTier(transport).rewind === "fork") return true;
  return transport === "acp" && !!catalogFor(agent, profile)?.catalogue?.capabilities?.fork;
}
