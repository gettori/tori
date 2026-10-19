import type { Pick } from "../pick";

const HTML_CAP = 4096;
const TEXT_CAP = 1000;
const STYLE_CAP = 40;
const ATTRIBUTES = new Set(["id", "class", "role", "data-testid", "href", "src", "alt", "type", "name"]);

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

export function capture(
  el: Element,
  comment: string,
  baseline: ShadowRoot,
  selection?: { text: string; rect: DOMRect },
): Pick {
  const r = selection?.rect ?? el.getBoundingClientRect();
  return {
    comment,
    kind: selection ? "selection" : "element",
    url: location.href,
    route: location.pathname + location.search + location.hash,
    selector: selectorOf(el),
    path: domPath(el),
    html: cleanHtml(el),
    text: cap(selection ? selection.text : textOf(el), TEXT_CAP),
    styles: stylesOf(el, baseline),
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    viewport: { width: innerWidth, height: innerHeight },
    dpr: devicePixelRatio,
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  };
}
