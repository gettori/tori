import type { ToolItem } from "./chatStore";

export type ToriCall = { tool: string; args: Record<string, unknown> };

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Which Tori tool a card is, across providers: Claude names the call
 *  `mcp__tori__<tool>`, an ACP agent titles it `mcp.tori.<tool>` and wraps the
 *  arguments as `{ server, tool, arguments }`. Null for anything else. */
export function toriCall(card: Pick<ToolItem, "name" | "title" | "input">): ToriCall | null {
  const input = record(card.input);
  if (input?.server === "tori" && typeof input.tool === "string") {
    return { tool: input.tool, args: record(input.arguments) ?? {} };
  }
  const tool =
    /^mcp__tori__(\w+)$/.exec(card.name ?? "")?.[1] ?? /^mcp\.tori\.(\w+)$/.exec(card.title ?? "")?.[1] ?? null;
  return tool ? { tool, args: input ?? {} } : null;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The object a Tori tool replied with. Claude's output is the reply's text;
 *  an ACP agent's is the whole MCP result, the reply inside `content`. */
export function toriReply(output: string | null): Record<string, unknown> | null {
  const outer = record(output === null ? null : parse(output));
  const content = record(outer?.result)?.content;
  if (!Array.isArray(content)) return outer;
  const text = content.map((b) => record(b)?.text).find((t): t is string => typeof t === "string");
  return text === undefined ? null : record(parse(text));
}
