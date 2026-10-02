// The WebKit half of sanitizer-probe.mjs, which is how this is run: it loads
// the bundle it is handed into a real WKWebView, the engine the app ships on,
// and reports which payloads still ran script after `sanitizeHtml`.
import AppKit
import WebKit

guard CommandLine.arguments.count == 2,
  let bundle = try? String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
else {
  FileHandle.standardError.write("usage: swift dev/sanitizer-probe.swift <bundle.js>\n".data(using: .utf8)!)
  exit(2)
}

let probe = """
const payloads = {
  onerror: '<img src=x onerror="window.hit(`onerror`)">',
  tabInScheme: '<a href="java&#9;script:window.hit(`tabInScheme`)">x</a>',
  xlinkHref: '<svg><a xlink:href="javascript:window.hit(`xlinkHref`)"><text y=20>x</text></a></svg>',
  animateHref: '<svg><a><animate attributeName=href values="javascript:window.hit(`animateHref`)" /><text y=20>x</text></a></svg>',
  noscript: '<noscript><p title="</noscript><img src=x onerror=window.hit(`noscript`)>"></p></noscript>',
  mathml: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=window.hit(`mathml`)&gt;">',
  formaction: '<form><button formaction="javascript:window.hit(`formaction`)">x</button></form>',
  details: '<details open ontoggle="window.hit(`details`)">x</details>',
  srcdoc: '<iframe srcdoc="<script>parent.hit(`srcdoc`)</script>"></iframe>',
};
const hits = [];
window.hit = (name) => hits.push(name);
const settle = () => new Promise((done) => setTimeout(done, 400));
const mount = (html) => {
  const box = document.createElement("div");
  document.body.appendChild(box);
  box.innerHTML = html;
  return box;
};
const press = (box) => {
  for (const el of box.querySelectorAll("a, button")) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
};

// Unsanitized first: a probe that cannot see a payload fire proves nothing.
const control = mount(payloads.onerror.replace("onerror`", "control`"));
await settle();
const armed = hits.includes("control");
hits.length = 0;
control.remove();

const boxes = Object.values(payloads).map((p) => mount(tori.sanitizeHtml(p)));
await settle();
boxes.forEach(press);
await settle();
return JSON.stringify({ armed, hits: [...new Set(hits)], payloads: Object.keys(payloads).length });
"""

final class Runner: NSObject, WKNavigationDelegate {
  let bundle: String
  let probe: String

  init(bundle: String, probe: String) {
    self.bundle = bundle
    self.probe = probe
  }

  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    view.evaluateJavaScript(bundle) { [probe] _, error in
      if let error {
        print("the bundle did not load: \(error)")
        exit(2)
      }
      view.callAsyncJavaScript(probe, arguments: [:], in: nil, in: .page) { result in
        guard case .success(let value) = result, let text = value as? String,
          let report = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
          let armed = report["armed"] as? Bool, let hits = report["hits"] as? [String]
        else {
          print("the probe did not report: \(result)")
          exit(2)
        }
        print(text)
        exit(armed && hits.isEmpty ? 0 : 1)
      }
    }
  }
}

let app = NSApplication.shared
let view = WKWebView(frame: .init(x: 0, y: 0, width: 400, height: 300))
let runner = Runner(bundle: bundle, probe: probe)
view.navigationDelegate = runner
view.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: URL(string: "https://tauri.localhost/"))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
  print("timed out")
  exit(2)
}
app.run()
