// A markdown file, an agent transcript and a language server's documentation
// are all untrusted, and the Tauri webview can call backend commands, so a
// script that runs from any of them runs with the app's own reach.
import DOMPurify from "dompurify";

// DOMPurify's defaults allow these, and none belongs in prose: a <style> can
// redraw the app around the content, and a form can post what it collects.
const FORBID_TAGS = ["style", "form", "button", "select", "option", "textarea"];
const FORBID_ATTR = ["style"];

// DOMPurify's own list plus `tori:`, the scheme the autopilot links a place in
// the app with. A scheme it does not know loses its href.
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|tori):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | undefined;

// Its own instance: mermaid sanitizes through the shared default one, and a
// hook added there would run on every diagram too.
function instance(): Purifier {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  purifier.addHook("afterSanitizeAttributes", (node) => {
    // `marked` draws a task list item as a checkbox, the only input prose needs.
    if (node.nodeName === "INPUT" && node.getAttribute("type") !== "checkbox") node.remove();
  });
  return purifier;
}

export function sanitizeHtml(html: string): string {
  return instance().sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS, FORBID_ATTR, ALLOWED_URI_REGEXP });
}
