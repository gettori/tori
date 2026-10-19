import type { InspectChannel, InspectMessage, MatchedRule, Pick, Where } from "../pick";
import { matchRules, shrinkStyles, type SheetLike } from "./rules";

const HTML_CAP = 4096;
const TEXT_CAP = 1000;
const STYLE_CAP = 40;
const ATTRIBUTES = new Set(["id", "class", "role", "data-testid", "href", "src", "alt", "type", "name"]);

const INSPECT: InspectChannel = "tori:inspect";
const SOURCE_ATTRIBUTE = "data-insp-path";
const GENERATED = /^\/\*! tailwindcss /;

const LOGICAL_TWIN = /(^|-)(block|inline)(-|$)|-(start|end)-/;
const SIZE_ORIGIN = /^(perspective|transform)-origin$/;

const kept = (name: string) => ATTRIBUTES.has(name) || name.startsWith("aria-");

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function isSensitive(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  return (
    (el instanceof HTMLInputElement && el.type === "password") ||
    el.getAttribute("autocomplete") === "off" ||
    el.hasAttribute("data-sensitive")
  );
}

export function insideSensitive(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el && isSensitive(el);
}

function cleanHtml(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    if (node instanceof HTMLTextAreaElement && isSensitive(node)) node.textContent = "";
    for (const { name } of [...node.attributes]) if (!kept(name)) node.removeAttribute(name);
  }
  return cap(clone.outerHTML, HTML_CAP);
}

function textOf(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return isSensitive(el) ? "" : el.value;
  return el instanceof HTMLElement ? el.innerText : (el.textContent ?? "");
}

function part(el: Element): string {
  const id = el.id ? `#${CSS.escape(el.id)}` : "";
  const classes = [...el.classList]
    .slice(0, 2)
    .map((c) => `.${CSS.escape(c)}`)
    .join("");
  return `${el.localName}${id}${classes}`;
}

function domPath(el: Element): string {
  const parts: string[] = [];
  for (let at: Element | null = el; at; at = at.parentElement) parts.unshift(part(at));
  return parts.join(" > ");
}

const unique = (selector: string) => document.querySelectorAll(selector).length === 1;

function step(el: Element): string {
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const base = part(el);
  const parent = el.parentElement;
  if (!parent) return base;
  const same = [...parent.children].filter((c) => c.localName === el.localName);
  return same.length > 1 ? `${base}:nth-of-type(${same.indexOf(el) + 1})` : base;
}

function selectorOf(el: Element): string {
  const steps: string[] = [];
  for (let at: Element | null = el; at; at = at.parentElement) {
    steps.unshift(step(at));
    const selector = steps.join(" > ");
    if (unique(selector)) return selector;
  }
  return steps.join(" > ");
}

// The baseline is a fresh element of the same tag inside the overlay's shadow
// root, so it has the UA defaults and none of the page's rules.
function stylesOf(el: Element, baseline: ShadowRoot): Record<string, string> {
  const fresh = document.createElement(el.localName);
  baseline.append(fresh);
  const mine = getComputedStyle(el);
  const theirs = getComputedStyle(fresh);
  const out: Record<string, string> = {};
  const color = mine.getPropertyValue("color");
  for (const name of mine) {
    if (name.startsWith("-") || LOGICAL_TWIN.test(name) || SIZE_ORIGIN.test(name)) continue;
    const value = mine.getPropertyValue(name);
    if (name !== "color" && name.endsWith("-color") && value === color) continue;
    if (value !== theirs.getPropertyValue(name)) out[name] = value;
    if (Object.keys(out).length >= STYLE_CAP) break;
  }
  fresh.remove();
  return out;
}

function askInspect(el: Element): Extract<InspectMessage, { type: "found" }> | null {
  let found: InspectMessage | null = null;
  const listen = (e: Event) => {
    if (!(e instanceof CustomEvent) || typeof e.detail !== "string") return;
    try {
      const message = JSON.parse(e.detail) as InspectMessage;
      if (message.type === "found") found = message;
    } catch {
      // Page code can dispatch anything under this event name.
      return;
    }
  };
  document.addEventListener(INSPECT, listen);
  const ask: InspectMessage = { type: "ask", sensitive: isSensitive(el) };
  el.dispatchEvent(new CustomEvent(INSPECT, { bubbles: true, detail: JSON.stringify(ask) }));
  document.removeEventListener(INSPECT, listen);
  return found;
}

// code-inspector-plugin writes `/abs/file:line:column:tag`.
function sourceOf(value: string | null | undefined): string | null {
  const match = value?.match(/^(.+):(\d+):\d+:[^:]*$/);
  return match ? `${match[1]}:${match[2]}` : null;
}

export const hasLine = (source: string | null): source is string => source !== null && /:\d+$/.test(source);

function sourceFor(framework: string | null, el: Element): string | null {
  if (hasLine(framework)) return framework;
  return sourceOf(el.closest(`[${SOURCE_ATTRIBUTE}]`)?.getAttribute(SOURCE_ATTRIBUTE)) ?? framework;
}

// Vite's dev server tags each sheet it injects with the file it came from. A
// query means the sheet is one block of a bigger file, such as a Vue SFC style,
// and a generated sheet's lines are not the file's.
function sheetOf(sheet: CSSStyleSheet): SheetLike | null {
  let cssRules: CSSRuleList;
  try {
    cssRules = sheet.cssRules;
  } catch {
    // Another origin's sheet, which the page itself cannot read either.
    return null;
  }
  const owner = sheet.ownerNode;
  const devId = owner instanceof HTMLStyleElement ? owner.getAttribute("data-vite-dev-id") : null;
  if (devId) {
    const [file, query] = devId.split("?");
    const text = owner!.textContent ?? "";
    const exact = query === undefined && !GENERATED.test(text);
    return { cssRules, where: file, text: exact ? text : null, exact };
  }
  const where = sheet.href ? new URL(sheet.href).pathname : "inline <style>";
  return { cssRules, where, text: null, exact: false };
}

function rulesOf(el: Element): { rules: MatchedRule[]; properties: string[] } {
  const sheets = [...document.styleSheets].map(sheetOf).filter((s): s is SheetLike => s !== null);
  return matchRules(sheets, {
    matches: (selector) => el.matches(selector),
    media: (query) => matchMedia(query).matches,
    supports: (condition) => CSS.supports(condition),
  });
}

function whereOf(el: Element, rules: MatchedRule[]): Where {
  const found = askInspect(el);
  const nearest = (attribute: string) => el.closest(`[${attribute}]`)?.getAttribute(attribute) ?? "";
  return {
    chain: found?.chain ?? [],
    props: found?.props ?? null,
    source: sourceFor(found?.source ?? null, el),
    rules,
    testId: nearest("data-testid"),
    id: el.id,
    label: nearest("aria-label"),
  };
}

export function capture(
  el: Element,
  comment: string,
  baseline: ShadowRoot,
  selection?: { text: string; rect: DOMRect },
): Omit<Pick, "images"> {
  const r = selection?.rect ?? el.getBoundingClientRect();
  const matched = rulesOf(el);
  const computed = getComputedStyle(el);
  return {
    comment,
    kind: selection ? "selection" : "element",
    url: location.href,
    route: location.pathname + location.search + location.hash,
    selector: selectorOf(el),
    path: domPath(el),
    html: cleanHtml(el),
    text: cap(selection ? selection.text : textOf(el), TEXT_CAP),
    styles: matched.rules.length
      ? shrinkStyles(matched.properties, (name) => computed.getPropertyValue(name), STYLE_CAP)
      : stylesOf(el, baseline),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    viewport: { width: innerWidth, height: innerHeight },
    dpr: devicePixelRatio,
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    where: whereOf(el, matched.rules),
    at: Date.now(),
  };
}
