// The work recipe's inputs, generated rather than checked in: deterministic, so
// two runs feed the same bytes, and sized by argument so a run can scale them.

const WORDS = [
  "the", "worker", "answers", "each", "block", "with", "colours", "while", "stream", "keeps",
  "text", "current", "frame", "paint", "lexer", "token", "grammar", "session", "branch", "commit",
];

function words(seed: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(seed * 7 + i * 13) % WORDS.length]);
  return out.join(" ");
}

const TS_BLOCK = (i: number) =>
  [
    "```ts",
    `export function handler${i}(input: Record<string, unknown>): string | null {`,
    `  // A comment that spans the line, ${words(i, 6)}`,
    `  const value = typeof input.key${i} === "string" ? input.key${i} : null;`,
    `  if (!value) return null;`,
    `  return \`\${value}-${i}\`.replace(/[^a-z0-9-]/g, "");`,
    "}",
    "```",
  ].join("\n");

const RUST_BLOCK = (i: number) =>
  [
    "```rust",
    `pub fn step_${i}(items: &[String]) -> Result<Vec<String>, String> {`,
    `    items.iter().filter(|s| !s.is_empty()).map(|s| Ok(format!("{s}-${i}"))).collect()`,
    "}",
    "```",
  ].join("\n");

function section(i: number): string {
  return [
    `## Step ${i}`,
    "",
    `${words(i, 40)}. ${words(i + 1, 30)}, with \`inline${i}\` and **bold ${i}**.`,
    "",
    `- ${words(i + 2, 8)}`,
    `- ${words(i + 3, 10)}`,
    `- [a link](https://example.com/${i})`,
    "",
    i % 2 ? TS_BLOCK(i) : RUST_BLOCK(i),
    "",
    "| name | value |",
    "| --- | --- |",
    `| key${i} | ${words(i, 3)} |`,
    "",
  ].join("\n");
}

// About four characters a token, which is close enough for sizing.
export function streamedAnswer(tokens = 20_000): string {
  const target = tokens * 4;
  let out = "";
  for (let i = 0; out.length < target; i++) out += section(i) + "\n";
  return out;
}

export function projectPaths(n = 50_000): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pkg = i % 40;
    const area = (i * 7) % 25;
    const ext = ["ts", "tsx", "rs", "md", "json"][i % 5];
    out.push(`packages/pkg-${pkg}/src/area-${area}/${WORDS[i % WORDS.length]}/${WORDS[(i * 3) % WORDS.length]}${i}.${ext}`);
  }
  return out;
}

// Every seventh line changed, so the diff has many small hunks rather than one.
export function bigEdit(lines = 5_000): { file_path: string; old_string: string; new_string: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (let i = 0; i < lines; i++) {
    const line = `  const v${i} = compute(${i}, "${words(i, 3)}");`;
    before.push(line);
    after.push(i % 7 ? line : `  const v${i} = computeFaster(${i}, "${words(i + 1, 3)}");`);
  }
  return { file_path: "/tori-perf/big.ts", old_string: before.join("\n"), new_string: after.join("\n") };
}

export function bigMarkdown(bytes = 1_000_000): string {
  let out = "# A large document\n\n";
  for (let i = 0; out.length < bytes; i++) out += section(i) + "\n";
  return out;
}

export function diagrams(n = 10): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`Diagram ${i}:`, "", "```mermaid", "flowchart LR");
    for (let j = 0; j < 12; j++) out.push(`  n${j}[${WORDS[(i + j) % WORDS.length]}] --> n${j + 1}`);
    out.push("```", "");
  }
  return out.join("\n");
}
