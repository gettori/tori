// Strips script-execution vectors from marked's rendered HTML before it goes
// into innerHTML: a local markdown file (a plan doc, a README, an agent
// transcript export) is untrusted content as far as script execution goes,
// and the Tauri webview can call backend commands, so an embedded <script>
// or an `on*`/`javascript:` handler is a real risk, not a theoretical one.
// Allowlist-based (removes disallowed elements/attributes) rather than a
// blocklist, so an unknown-but-dangerous tag/attribute is dropped by default.
const DISALLOWED_TAGS = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form"]);

function isDangerousAttr(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("on")) return true;
  if ((n === "href" || n === "src") && /^\s*javascript:/i.test(value)) return true;
  return false;
}

function sanitizeNode(node: Element) {
  for (const child of Array.from(node.children)) {
    if (DISALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      if (isDangerousAttr(attr.name, attr.value)) child.removeAttribute(attr.name);
    }
    sanitizeNode(child);
  }
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}
