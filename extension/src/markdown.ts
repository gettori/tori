import type { LogEntry, Pick } from "./pick";

// Longer than any backtick run inside, so page markup cannot close the block.
function fence(body: string, lang = ""): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Screenshots travel as attachments, which the agent sees as [Image n] in the
// order they are attached: each pick's own, viewport first.
function shots(keys: string[], first: number): string {
  return keys.map((key, i) => `[Image ${first + i}] ${key.split(":").pop()}`).join(", ");
}

export function pickToMarkdown(pick: Pick, n: number, firstImage?: number): string {
  const r = pick.rect;
  const facts = [
    `url: ${pick.url}`,
    ...(pick.kind === "selection" ? ["picked: selection"] : []),
    `selector: ${pick.selector}`,
    `path: ${pick.path}`,
    `rect: ${r.x},${r.y} ${r.width}x${r.height}`,
    `viewport: ${pick.viewport.width}x${pick.viewport.height}`,
    `dpr: ${pick.dpr}`,
    `theme: ${pick.theme}`,
    ...(firstImage !== undefined && pick.images.length ? [`screenshots: ${shots(pick.images, firstImage)}`] : []),
  ].join("\n");
  const styles = Object.entries(pick.styles)
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n");
  return [
    `### ${n}. ${oneLine(pick.comment) || "(no comment)"}`,
    fence(facts),
    ...(pick.html ? [fence(pick.html, "html")] : []),
    ...(pick.text ? [fence(pick.text, "text")] : []),
    ...(styles ? [fence(styles, "css")] : []),
  ].join("\n\n");
}

function offset(ms: number): string {
  return `${ms < 0 ? "-" : "+"}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

// Times run from the first pick, so what the page said before it reads as negative.
export function logToMarkdown(log: LogEntry[], origin: number): string {
  const lines = log.map((entry) => {
    const [head, ...rest] = entry.text.split("\n");
    const times = entry.count > 1 ? ` x${entry.count}` : "";
    return [`${offset(entry.at - origin)} ${entry.kind}: ${head}${times}`, ...rest.map((line) => `  ${line}`)].join(
      "\n",
    );
  });
  return `### Page log\n\n${fence(lines.join("\n"))}`;
}

export function batchToMarkdown(picks: Pick[], withImages = false, log: LogEntry[] = []): string {
  let image = 1;
  const sections = picks.map((pick, i) => {
    const md = pickToMarkdown(pick, i + 1, withImages ? image : undefined);
    image += pick.images.length;
    return md;
  });
  if (log.length) sections.push(logToMarkdown(log, picks[0]?.at ?? log[0].at));
  return sections.join("\n\n");
}
