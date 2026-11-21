const path = require("path"),
  fs = require("fs");
const root = path.resolve(process.argv[2] ?? ".");
const ts = require(path.join(root, "node_modules/typescript"));
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "target") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(p);
  }
})(path.join(root, "src"));
for (const extra of ["mobile/src", "extension/src"]) {
  const d = path.join(root, extra);
  if (fs.existsSync(d))
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    })(d);
}
const c = {};
const bump = (k, f) => {
  (c[k] ||= { n: 0, files: new Set() }).n++;
  c[k].files.add(f);
};
const ex = {};
const note = (k, s) => {
  if ((ex[k] ||= []).length < 6) ex[k].push(s);
};
const isSetter = (n) => /^set[A-Z]/.test(n);
for (const f of files) {
  const isTest = /\.test\.tsx?$/.test(f) || f.includes("/test/");
  const tag = isTest ? "test" : "app";
  const src = fs.readFileSync(f, "utf8");
  if (!/solid-js|createSignal|createEffect/.test(src)) continue;
  const sf = ts.createSourceFile(
    f,
    src,
    ts.ScriptTarget.Latest,
    true,
    f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const rel = path.relative(root, f);
  const loc = (n) => rel + ":" + (sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
  const scan = (node, pred) => {
    let hit = false;
    (function v(n) {
      if (hit) return;
      if (pred(n)) {
        hit = true;
        return;
      }
      ts.forEachChild(n, v);
    })(node);
    return hit;
  };
  const callName = (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text : null);
  const fnDepth = (n) => {
    let d = 0,
      p = n.parent;
    while (p) {
      if (ts.isFunctionLike(p)) d++;
      p = p.parent;
    }
    return d;
  };
  const enclosingKinds = (n) => {
    // is it inside a JSX attribute handler or a nested callback of a non-component function?
    let p = n.parent,
      inJsxAttr = false,
      inCallCb = null;
    while (p) {
      if (ts.isJsxAttribute(p)) inJsxAttr = true;
      if (ts.isCallExpression(p) && !inCallCb)
        inCallCb = callName(p) || (ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : "?");
      p = p.parent;
    }
    return { inJsxAttr, inCallCb };
  };
  (function visit(n) {
    const name = callName(n);
    if (name === "createEffect") {
      bump(`${tag} createEffect`, rel);
      const a0 = n.arguments[0];
      const usesOn = a0 && callName(a0) === "on";
      const body = usesOn ? a0.arguments[1] : a0;
      if (usesOn) bump(`${tag} createEffect: on() form`, rel);
      if (body) {
        const writes = scan(body, (x) => {
          const cn = callName(x);
          return cn && isSetter(cn);
        });
        const asyncy =
          scan(
            body,
            (x) =>
              x.kind === ts.SyntaxKind.AwaitExpression ||
              (ts.isCallExpression(x) &&
                ts.isPropertyAccessExpression(x.expression) &&
                x.expression.name.text === "then"),
          ) ||
          (ts.isFunctionLike(body) && body.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
        const cleanup = scan(body, (x) => callName(x) === "onCleanup");
        const nested = scan(body, (x) =>
          ["createEffect", "createMemo", "createRoot", "createSignal", "createResource"].includes(callName(x)),
        );
        const untr = scan(body, (x) => callName(x) === "untrack");
        const invoke = scan(body, (x) => callName(x) === "invoke" || callName(x) === "listen");
        const prev = ts.isFunctionLike(body) && body.parameters.length > 0 && !usesOn;
        if (writes) {
          bump(`${tag} createEffect: writes a setter in body`, rel);
          if (!isTest) note("effect-writes", loc(n));
        }
        if (asyncy) bump(`${tag} createEffect: async or .then in body`, rel);
        if (cleanup) bump(`${tag} createEffect: onCleanup inside`, rel);
        if (nested) {
          bump(`${tag} createEffect: creates primitives inside`, rel);
          if (!isTest) note("effect-nested", loc(n));
        }
        if (untr) bump(`${tag} createEffect: untrack inside`, rel);
        if (invoke) bump(`${tag} createEffect: invoke/listen inside`, rel);
        if (prev) bump(`${tag} createEffect: prev param`, rel);
        if (!writes && !asyncy && !cleanup && !nested)
          bump(`${tag} createEffect: plain side effect (DOM or call)`, rel);
      }
      if (fnDepth(n) === 0) bump(`${tag} createEffect: module level`, rel);
      const k = enclosingKinds(n);
      if (k.inJsxAttr) {
        bump(`${tag} createEffect: inside JSX attribute callback`, rel);
        note("effect-in-handler", loc(n));
      }
    }
    if (name === "createResource") {
      bump(`${tag} createResource`, rel);
      const args = n.arguments;
      const second = args[1];
      const hasSource = second && (ts.isFunctionLike(second) || ts.isIdentifier(second));
      bump(`${tag} createResource: ${hasSource ? "source + fetcher" : "fetcher only"}`, rel);
      const last = args[args.length - 1];
      if (last && ts.isObjectLiteralExpression(last)) {
        for (const p of last.properties) if (p.name) bump(`${tag} createResource option: ${p.name.getText()}`, rel);
      }
      const decl = n.parent;
      if (ts.isVariableDeclaration(decl) && ts.isArrayBindingPattern(decl.name)) {
        const second = decl.name.elements[1];
        if (second && ts.isBindingElement(second) && ts.isObjectBindingPattern(second.name))
          for (const el of second.name.elements)
            bump(`${tag} createResource uses ${(el.propertyName || el.name).getText()}`, rel);
        else if (second && !ts.isOmittedExpression(second)) bump(`${tag} createResource uses actions object`, rel);
      }
      if (fnDepth(n) === 0) bump(`${tag} createResource: module level`, rel);
    }
    if (name === "onMount") {
      bump(`${tag} onMount`, rel);
      const b = n.arguments[0];
      if (b && ts.isFunctionLike(b) && b.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
        bump(`${tag} onMount: async`, rel);
      if (b && scan(b, (x) => callName(x) === "onCleanup")) bump(`${tag} onMount: onCleanup inside`, rel);
      if (
        b &&
        scan(b, (x) =>
          ["createEffect", "createMemo", "createRoot", "createSignal", "createResource"].includes(callName(x)),
        )
      ) {
        bump(`${tag} onMount: creates primitives inside`, rel);
        if (!isTest) note("onmount-nested", loc(n));
      }
      if (
        b &&
        scan(b, (x) => {
          const cn = callName(x);
          return cn && isSetter(cn);
        })
      )
        bump(`${tag} onMount: writes a setter`, rel);
    }
    if (name === "onCleanup") {
      bump(`${tag} onCleanup`, rel);
      let p = n.parent,
        inRef = false;
      while (p) {
        if (ts.isJsxAttribute(p) && p.name.getText() === "ref") inRef = true;
        p = p.parent;
      }
      if (inRef) {
        bump(`${tag} onCleanup: inside ref callback`, rel);
        note("cleanup-in-ref", loc(n));
      }
    }
    if (name === "createMemo") {
      bump(`${tag} createMemo`, rel);
      const b = n.arguments[0];
      if (
        b &&
        scan(b, (x) => {
          const cn = callName(x);
          return cn && isSetter(cn);
        })
      ) {
        bump(`${tag} createMemo: writes a setter`, rel);
        if (!isTest) note("memo-writes", loc(n));
      }
      if (n.arguments.length > 1) {
        bump(`${tag} createMemo: has 2nd/3rd arg`, rel);
        if (!isTest) note("memo-args", loc(n));
      }
    }
    if (name === "createSignal") {
      bump(`${tag} createSignal`, rel);
      if (fnDepth(n) === 0) bump(`${tag} createSignal: module level`, rel);
      const a = n.arguments[0];
      if (a && (ts.isFunctionLike(a) || (ts.isIdentifier(a) && /^(noop|handler|fn|cb|callback)$/i.test(a.text)))) {
        bump(`${tag} createSignal: function as initial value`, rel);
        note("signal-fn-init", loc(n));
      }
      if (n.typeArguments?.[0] && /=>/.test(n.typeArguments[0].getText())) {
        bump(`${tag} createSignal: type arg contains a function type`, rel);
        note("signal-fn-type", loc(n));
      }
      if (n.arguments[1]) bump(`${tag} createSignal: has options`, rel);
    }
    if (name === "createStore") {
      bump(`${tag} createStore`, rel);
      if (fnDepth(n) === 0) bump(`${tag} createStore: module level`, rel);
    }
    if (name === "createRoot") {
      bump(`${tag} createRoot`, rel);
      if (fnDepth(n) === 0) bump(`${tag} createRoot: module level`, rel);
      else if (!isTest) note("root-nested", loc(n));
    }
    if (name === "batch") bump(`${tag} batch`, rel);
    if (name === "untrack") bump(`${tag} untrack`, rel);
    if (name === "produce") bump(`${tag} produce`, rel);
    if (name === "reconcile") bump(`${tag} reconcile`, rel);
    if (name === "on" && !(n.parent && callName(n.parent) === "createEffect"))
      bump(`${tag} on() outside createEffect`, rel);
    if (name && isSetter(name) && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0]))
      bump(`${tag} setter with string path first arg`, rel);
    // read right after write: setX(...); followed in the same block by x() read where x matches
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      const st = n.statements;
      for (let i = 0; i < st.length - 1; i++) {
        const s = st[i];
        if (!ts.isExpressionStatement(s)) continue;
        const cn = callName(s.expression);
        if (!cn || !isSetter(cn)) continue;
        const getter = cn[3].toLowerCase() + cn.slice(4);
        for (let j = i + 1; j < Math.min(st.length, i + 6); j++) {
          if (scan(st[j], (x) => callName(x) === getter && x.arguments.length === 0)) {
            bump(`${tag} read of X() within 5 statements after setX()`, rel);
            if (!isTest) note("read-after-write", loc(st[j]));
            break;
          }
        }
      }
    }
    if (ts.isJsxAttribute(n)) {
      const an = n.name.getText();
      if (an === "classList") bump(`${tag} JSX classList`, rel);
      if (an === "ref") {
        bump(`${tag} JSX ref`, rel);
        const init = n.initializer;
        if (init && ts.isJsxExpression(init) && init.expression && ts.isFunctionLike(init.expression))
          bump(`${tag} JSX ref: inline callback`, rel);
      }
      if (
        /^on[a-z]/.test(an) &&
        n.parent.parent &&
        ts.isIdentifier(n.parent.parent.tagName) &&
        /^[a-z]/.test(n.parent.parent.tagName.text)
      ) {
        bump(`${tag} JSX lowercase on* on native element`, rel);
        note("lower-on", loc(n));
      }
      if (
        /^on[A-Z]/.test(n.name.getText()) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression &&
        ts.isConditionalExpression(n.initializer.expression)
      ) {
        bump(`${tag} JSX handler chosen by ternary (binds once in 2.0)`, rel);
        note("handler-ternary", loc(n));
      }
      if (
        /^on[A-Z]/.test(an) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression &&
        ts.isArrayLiteralExpression(n.initializer.expression)
      )
        bump(`${tag} JSX handler tuple form`, rel);
      if (
        (an === "value" || an === "checked") &&
        n.parent.parent &&
        ts.isIdentifier(n.parent.parent.tagName) &&
        /^(input|textarea|select)$/.test(n.parent.parent.tagName.text)
      )
        bump(`${tag} JSX controlled value/checked on input`, rel);
      if (
        /^(aria-[a-z]+|draggable|spellcheck|contenteditable)$/.test(an) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression &&
        !ts.isStringLiteral(n.initializer.expression)
      )
        bump(`${tag} JSX enumerated attr with non-string value (${an.startsWith("aria-") ? "aria-*" : an})`, rel);
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const t = n.tagName.getText();
      if (t.endsWith(".Provider")) bump(`${tag} JSX X.Provider`, rel);
      if (["Suspense", "ErrorBoundary", "Index", "Dynamic", "Portal", "For", "Show", "Switch", "Match"].includes(t))
        bump(`${tag} JSX <${t}>`, rel);
    }
    // destructured props / top-level props read in component body
    if (
      (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parameters.length === 1 &&
      ts.isIdentifier(n.parameters[0].name) &&
      n.parameters[0].name.text === "props" &&
      n.body &&
      ts.isBlock(n.body)
    ) {
      let flagged = false;
      for (const s of n.body.statements) {
        if (ts.isVariableStatement(s))
          for (const d of s.declarationList.declarations) {
            if (
              d.initializer &&
              ts.isIdentifier(d.initializer) &&
              d.initializer.text === "props" &&
              ts.isObjectBindingPattern(d.name)
            ) {
              bump(`${tag} component destructures props in body`, rel);
              note("props-destructure", loc(d));
            } else if (
              d.initializer &&
              ts.isPropertyAccessExpression(d.initializer) &&
              ts.isIdentifier(d.initializer.expression) &&
              d.initializer.expression.text === "props" &&
              !flagged
            ) {
              flagged = true;
              bump(`${tag} component reads props.x into a const at top of body`, rel);
              note("props-top-read", loc(d));
            }
          }
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
}
const keys = Object.keys(c).sort();
for (const k of keys) console.log(`${k}\t${c[k].n}\t${c[k].files.size} files`);
console.log("\nEXAMPLES");
for (const k of Object.keys(ex)) console.log(k + ": " + ex[k].join(", "));
