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

/** Model families that are certainly *not* Anthropic's. Only needed to stop a
 *  Claude-adapter session that is pointed at a router from wearing the Claude
 *  mark over someone else's model; an id this misses just falls back to the
 *  brain, which claims nothing. */
const OTHER_VENDOR = /gpt|openai|^o\d|gemini|llama|mistral|qwen|deepseek|grok|kimi|glm|command-r/;

/** Which mark a model id names, for the ids that name one at all. Separate from
 *  the adapter's own icon: this is the witness on the wire. */
function markForModel(id: string): Component<MarkProps> | undefined {
  if (/claude|anthropic/.test(id)) return agentMark("claude");
  return undefined;
}

/**
 * The mark for the provider behind a session, for `<Icon icon={...}>`.
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
export function providerIcon(
  model: string | null | undefined,
  agentId?: string | null,
): Component<MarkProps> {
  const id = (model ?? "").toLowerCase();
  const byModel = markForModel(id);
  if (byModel) return byModel;
  // A model that names a vendor we have no mark for keeps the brain, and must
  // not fall through to the adapter's: a Claude session on a GPT router would
  // otherwise wear Anthropic's logo over OpenAI's model.
  if (OTHER_VENDOR.test(id)) return Brain;
  return agentMark(agentId) ?? Brain;
}
