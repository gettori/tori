import { describe, expect, it } from "vite-plus/test";
import { sanitizeHtml } from "./sanitizeHtml";

const PAYLOADS: Record<string, string> = {
  onerror: '<img src=x onerror="window.hit()">',
  tabInScheme: '<a href="java&#9;script:window.hit()">x</a>',
  xlinkHref: '<svg><a xlink:href="javascript:window.hit()"><text y=20>x</text></a></svg>',
  animateHref: '<svg><a><animate attributeName=href values="javascript:window.hit()" /><text y=20>x</text></a></svg>',
  noscript: '<noscript><p title="</noscript><img src=x onerror=window.hit()>"></p></noscript>',
  mathml: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=window.hit()&gt;">',
  styleTag: "<style>body{display:none}</style><p>x</p>",
  styleAttr: '<div style="background:url(https://example.invalid/leak)">x</div>',
  form: '<form action="https://example.invalid/"><input name="q"><button>go</button></form>',
  script: "<script>window.hit()</script><p>x</p>",
  iframe: '<iframe srcdoc="<script>parent.hit()</script>"></iframe>',
};

function rendered(html: string): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = sanitizeHtml(html);
  return box;
}

describe("sanitizeHtml", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`leaves nothing that runs or reshapes the app: ${name}`, () => {
      const box = rendered(payload);
      for (const el of Array.from(box.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.toLowerCase().startsWith("on"), `${el.tagName} keeps ${attr.name}`).toBe(false);
          expect(attr.name.toLowerCase(), `${el.tagName} keeps style`).not.toBe("style");
          expect(attr.value.replace(/\s/g, "").toLowerCase(), `${el.tagName} ${attr.name}`).not.toContain("javascript:");
        }
      }
      expect(box.querySelector("script, style, form, button, iframe, svg, math")).toBeNull();
    });
  }

  it("keeps what markdown prose is made of", () => {
    const box = rendered(
      '<h2 id="a">T</h2><p><a href="https://example.com">l</a> <code>c</code> <img src="https://example.com/b.png" alt="b"></p>' +
        '<ul><li><input type="checkbox" disabled checked> done</li></ul><table><tr><td align="center">x</td></tr></table>',
    );
    expect(box.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(box.querySelector("img")?.getAttribute("src")).toBe("https://example.com/b.png");
    expect(box.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(box.querySelector("td")?.getAttribute("align")).toBe("center");
    expect(box.querySelector("h2")?.id).toBe("a");
  });

  it("drops an input that is not a task list checkbox", () => {
    expect(rendered('<input type="password" name="p">').querySelector("input")).toBeNull();
  });
});
