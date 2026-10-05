import { describe, expect, it } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LSPClient, LSPPlugin } from "@codemirror/lsp-client";
import { sanitizeHtml } from "../../utils/sanitizeHtml";

// The real library, not a stub: what is pinned is that documentation a server
// sent comes out of `docToHTML` already harmless, which is the string every
// tooltip in the editor puts into innerHTML.
describe("server documentation through the library's docToHTML", () => {
  function plugin(config: ConstructorParameters<typeof LSPClient>[0]) {
    const client = new LSPClient(config);
    const view = new EditorView({ state: EditorState.create({ extensions: [client.plugin("file:///a.ts")] }) });
    return LSPPlugin.get(view)!;
  }

  const DOC = { kind: "markdown", value: 'Reads a file.\n\n<img src="x" onerror="window.hit()">' } as const;

  it("carries the handler when nothing sanitizes, which is the library's default", () => {
    expect(plugin({}).docToHTML(DOC)).toContain("onerror");
  });

  it("drops it with the sanitizer the app passes", () => {
    const html = plugin({ sanitizeHTML: sanitizeHtml }).docToHTML(DOC);
    expect(html).not.toContain("onerror");
    expect(html).toContain("Reads a file.");
  });
});
