import type { MatchedRule } from "../pick";

// A block in a sheet's own text, lines counted from 1. Statements such as
// `@import ...;` count too, since the CSSOM lists them as rules.
export type Block = { start: number; end: number; prelude: string; children: Block[] | null };

type Specificity = [number, number, number];

const RULE_CAP = 12;
const DECLARATIONS_CAP = 300;
const GROUPS = /^@(media|supports|layer|container|scope|document)\b/i;

export function blocksOf(text: string): Block[] {
  let at = 0;
  let line = 1;
  const step = () => {
    if (text[at] === "\n") line++;
    at++;
  };
  const skipQuoted = (): boolean => {
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      const stop = end < 0 ? text.length : end + 2;
      while (at < stop) step();
      return true;
    }
    const quote = text[at];
    if (quote !== '"' && quote !== "'") return false;
    step();
    while (at < text.length && text[at] !== quote) {
      if (text[at] === "\\") step();
      step();
    }
    step();
    return true;
  };
  const skipBody = () => {
    let depth = 1;
    while (at < text.length && depth) {
      if (skipQuoted()) continue;
      if (text[at] === "{") depth++;
      else if (text[at] === "}") depth--;
      step();
    }
  };
  const list = (): Block[] => {
    const blocks: Block[] = [];
    let prelude = "";
    let start = 0;
    while (at < text.length) {
      if (skipQuoted()) continue;
      const c = text[at];
      if (c === "}") {
        step();
        return blocks;
      }
      if (c === "{") {
        const head = prelude.trim();
        const block: Block = { start, end: line, prelude: head, children: null };
        step();
        if (GROUPS.test(head)) block.children = list();
        else skipBody();
        block.end = line;
        blocks.push(block);
        prelude = "";
        continue;
      }
      if (c === ";") {
        const head = prelude.trim();
        if (head.startsWith("@")) blocks.push({ start, end: line, prelude: head, children: null });
        prelude = "";
        step();
        continue;
      }
      if (!prelude.trim() && !/\s/.test(c)) start = line;
      prelude += c;
      step();
    }
    return blocks;
  };
  return list();
}

// The CSSOM writes selectors back its own way: spaces around combinators, quoted attribute values.
const comparable = (selector: string) => selector.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[\s"']/g, "");

export function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && !depth) {
      parts.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(list.slice(from).trim());
  return parts.filter(Boolean);
}

export function specificity(selector: string): Specificity {
  const bare = selector
    .replace(/"[^"]*"|'[^']*'/g, "")
    .replace(/:where\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, ".a");
  const ids = bare.match(/#[\w-]+/g)?.length ?? 0;
  const classes = (bare.match(/\.[\w-]+/g)?.length ?? 0) + (bare.match(/(^|[^:]):(?!:)[\w-]+/g)?.length ?? 0);
  const elements = (bare.match(/(^|[\s>+~(])[a-zA-Z][\w-]*/g)?.length ?? 0) + (bare.match(/::[\w-]+/g)?.length ?? 0);
  return [ids, classes, elements];
}

const outranks = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const universalOrElementOnly = (s: Specificity) => !s[0] && !s[1];

export type RuleLike = {
  cssText: string;
  selectorText?: string;
  style?: { cssText: string; length: number; [index: number]: string };
  media?: { mediaText: string };
  conditionText?: string;
  containerName?: string;
  cssRules?: ArrayLike<RuleLike>;
};

export type SheetLike = { cssRules: ArrayLike<RuleLike>; where: string; text: string | null; exact: boolean };

export type Env = {
  matches: (selector: string) => boolean;
  media: (query: string) => boolean;
  supports: (condition: string) => boolean;
};

type Found = {
  rule: MatchedRule;
  rank: Specificity;
  cascadeIndex: number;
  properties: string[];
  sheet: SheetLike;
  path: number[];
  selectorText: string;
};

function applies(rule: RuleLike, env: Env): boolean | null {
  if (rule.media) return env.media(rule.media.mediaText);
  if (rule.containerName !== undefined) return false;
  if (rule.conditionText !== undefined) return env.supports(rule.conditionText);
  if (rule.cssRules && rule.selectorText === undefined) return true;
  return null;
}

function walk(rules: ArrayLike<RuleLike>, path: number[], sheet: SheetLike, env: Env, out: Found[]) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const group = applies(rule, env);
    if (group !== null) {
      if (group && rule.cssRules) walk(rule.cssRules, [...path, i], sheet, env, out);
      continue;
    }
    if (rule.selectorText === undefined || !rule.style) continue;
    const hits = splitSelectors(rule.selectorText).filter((part) => {
      try {
        return env.matches(part);
      } catch {
        // The split can cut a selector the sheet accepted into a part matches() rejects.
        return false;
      }
    });
    const strong = hits.filter((part) => !universalOrElementOnly(specificity(part)));
    if (!strong.length) continue;
    out.push({
      rule: {
        selector: strong.join(", "),
        declarations:
          rule.style.cssText.length > DECLARATIONS_CAP
            ? `${rule.style.cssText.slice(0, DECLARATIONS_CAP)}...`
            : rule.style.cssText,
        location: sheet.where,
      },
      rank: strong.map(specificity).sort(outranks).pop()!,
      cascadeIndex: out.length,
      properties: Array.from({ length: rule.style.length }, (_, n) => rule.style![n]),
      sheet,
      path: [...path, i],
      selectorText: rule.selectorText,
    });
  }
}

// Each level pairs only when the text and the CSSOM hold the same number of rules.
function blockAt(blocks: Block[], rules: ArrayLike<RuleLike>, path: number[]): Block | null {
  let list: Block[] | null = blocks;
  let cssRules: ArrayLike<RuleLike> | undefined = rules;
  let block: Block | null = null;
  for (const i of path) {
    if (!list || !cssRules || list.length !== cssRules.length) return null;
    block = list[i];
    list = block.children;
    cssRules = cssRules[i].cssRules;
  }
  return block;
}

function lines(found: Found, blocks: Block[]): string {
  const block = blockAt(blocks, found.sheet.cssRules, found.path);
  if (!block || comparable(block.prelude) !== comparable(found.selectorText)) return "";
  return `:${block.start}${block.end > block.start ? `-${block.end}` : ""}`;
}

export function matchRules(sheets: SheetLike[], env: Env): { rules: MatchedRule[]; properties: string[] } {
  const found: Found[] = [];
  for (const sheet of sheets) walk(sheet.cssRules, [], sheet, env, found);
  const kept = found.sort((a, b) => outranks(b.rank, a.rank) || b.cascadeIndex - a.cascadeIndex).slice(0, RULE_CAP);
  const parsed = new Map<SheetLike, Block[]>();
  for (const f of kept) {
    if (!f.sheet.exact || f.sheet.text === null) continue;
    if (!parsed.has(f.sheet)) parsed.set(f.sheet, blocksOf(f.sheet.text));
    f.rule.location += lines(f, parsed.get(f.sheet)!);
  }
  return { rules: kept.map((f) => f.rule), properties: [...new Set(kept.flatMap((f) => f.properties))] };
}

export function shrinkStyles(
  properties: string[],
  computed: (name: string) => string,
  cap: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of properties.slice(0, cap)) out[name] = computed(name);
  return out;
}
