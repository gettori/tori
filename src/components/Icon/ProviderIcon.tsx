import { type Component } from "solid-js";
import { Brain } from "lucide-solid";
import { agentMark, type MarkProps } from "./agentMarks";

/**
 * The mark of whoever is actually answering, for the places that name a model:
 * the composer's model pill, the status strip's stats row, and a session's tab.
 *
 * A generic "brain" glyph sat in all of them before, and it said nothing the row
 * does not already say - every model is a model. The provider is the fact worth
 * a glyph, because it is the one thing about a session you cannot read off the
 * label: "opus-4.6" is Anthropic's, "gpt-5" is not, and Sway drives more than
 * one agent.
 *
 * The marks themselves live in `agentMarks.tsx`, which is also where the
 * settings cards and anything else wanting a agent logo reads them from. This
 * file is only the *resolution*: which mark, given a model id and an adapter.
 */

export type { MarkProps };

/** Which vendor a model id names, for the ids that name one at all.
 *
 *  Families only, never a full id: this answers "whose model is this" and
 *  nothing finer, so a version bump or a new size never touches it. An id no
 *  pattern matches is a model whose vendor Sway cannot name, which is a
 *  different answer from a wrong one. */
const MODEL_VENDORS: [RegExp, string][] = [
  [/claude|anthropic/, "anthropic"],
  [/gpt|openai|^o\d/, "openai"],
  [/gemini|palm|bison/, "google"],
  [/kimi|moonshot/, "moonshot"],
  [/llama|mistral|qwen|deepseek|grok|glm|command-r/, "other"],
];

/** Which vendor an *agent's* mark is a claim about.
 *
 *  Only the marks that are a vendor's logo are here. `opencode`, `pi` and the
 *  rest are a tool's own brand and claim nothing about who answers, so a model
 *  id can never contradict them and they are always safe to fall back to. */
const MARK_VENDORS: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  kimi: "moonshot",
};

function vendorOfModel(id: string): string | undefined {
  return MODEL_VENDORS.find(([pattern]) => pattern.test(id))?.[1];
}

/** Which mark a model id names on its own, with no agent to help.
 *
 *  Anthropic only, and not from `MARK_VENDORS`: the marks this build has for the
 *  other vendors are *product* logos, not company ones. Codex's mark is Codex's,
 *  so wearing it over a `gpt-*` model that some other agent is running would
 *  name the wrong program. Anthropic's is the company's, so it is the one mark
 *  a bare model id can earn. */
function markForModel(id: string): string | undefined {
  return vendorOfModel(id) === "anthropic" ? "claude" : undefined;
}

/**
 * Which mark a session earns, as the key `agentMarks` files them under, or
 * `null` for a session whose provider Sway cannot name.
 *
 * The key, not the component, because two callers want two different things out
 * of one decision: `providerIcon` wants the glyph, and a caller tinting that
 * glyph wants to know *whose* logo it ended up being. Resolving twice, once per
 * question, is how the tint and the mark drift apart.
 *
 * The model id is asked first and the agent second, because they answer
 * different questions: a agent can run a model that is not its vendor's
 * (a agent driving Claude, a Claude session pointed at a router), so the id on
 * the wire is the better witness whenever there is one. The agent id covers the
 * two cases the id cannot: a session before its first `system/init`, where the
 * pill says "Default" and the adapter is all we know, and a short alias like
 * "opus" or "sonnet-4.6" that names the model without naming the vendor.
 *
 * The agent id is used as the mark key directly. That is right for every
 * bundled adapter, whose `icon` matches its id, and a user adapter that names a
 * different icon simply falls through to the brain here - the settings cards,
 * which have the adapter itself rather than only its id, honour the field.
 */
export function providerMarkKey(
  model: string | null | undefined,
  agentId?: string | null,
): string | null {
  const id = (model ?? "").toLowerCase();
  const byModel = markForModel(id);
  if (byModel) return byModel;
  // The agent's mark, unless the model on the wire *contradicts* it.
  //
  // This used to be "any model naming a vendor other than Anthropic keeps the
  // brain", which was wrong for the ordinary case: Codex runs `gpt-*` by
  // definition, so every Codex session matched and lost the Codex mark to a
  // generic brain. The guard was firing on the one pairing it was never about.
  //
  // Contradiction needs two vendor claims, not one. A mark that is a tool's own
  // brand (`opencode`, `pi`) claims nothing about who answers, so no model id
  // can disagree with it; only `claude` over a GPT id, or `codex` over a Claude
  // one, is the router mismatch this exists to catch.
  const declared = agentId ? MARK_VENDORS[agentId] : undefined;
  const running = vendorOfModel(id);
  if (declared && running && declared !== running) return null;
  return agentId && agentMark(agentId) ? agentId : null;
}

/** The mark for the provider behind a session, for `<Icon icon={...}>`. The
 *  brain is what a session with no nameable provider wears; see
 *  `providerMarkKey` for the decision itself. */
export function providerIcon(
  model: string | null | undefined,
  agentId?: string | null,
): Component<MarkProps> {
  return agentMark(providerMarkKey(model, agentId)) ?? Brain;
}
