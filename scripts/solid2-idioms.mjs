import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const isSetter = (n) => /^set[A-Z]/.test(n);

// Read at run time: vitest caches a glob's expansion with the test's transform,
// so a file added after that run would go unscanned.
export function appSources(root = fileURLToPath(new URL("..", import.meta.url))) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push([path, readFileSync(join(root, path), "utf8")]);
      }
    }
  };
  for (const dir of ["src", "mobile/src", "extension/src"]) walk(dir);
  return out;
}

const LABEL_CLASS = {
  "createEffect: writes a setter in body": "effect-writes",
  "createEffect: inside JSX attribute callback": "effect-in-handler",
  "onCleanup: inside ref callback": "cleanup-in-ref",
  "onMount: creates primitives inside": "onmount-primitive",
  "createSignal: function as initial value": "function-signal",
  "createSignal: type arg contains a function type": "function-signal",
  "read of X() within 5 statements after setX()": "read-after-write",
  "JSX handler chosen by ternary (binds once in 2.0)": "handler-ternary",
  "JSX lowercase on* on native element": "lowercase-on",
  "component destructures props in body": "destructured-props",
  "component reads props.x into a const at top of body": "top-prop-read",
  batch: "batch",
};

const FREE_ARIA = new Set(
  "label labelledby describedby controls owns activedescendant details errormessage flowto keyshortcuts roledescription valuetext placeholder valuemin valuemax valuenow posinset setsize level colcount colindex colspan rowcount rowindex rowspan"
    .split(" ")
    .map((name) => `aria-${name}`),
);
const ENUMERATED = new Set(["draggable", "spellcheck", "contenteditable"]);
const isEnumerated = (name) => ENUMERATED.has(name) || (name.startsWith("aria-") && !FREE_ARIA.has(name));

const CAMEL_ATTRS = new Set(
  "tabIndex readOnly htmlFor maxLength minLength autoFocus autoComplete autoPlay autoCapitalize autoCorrect colSpan rowSpan crossOrigin srcSet contentEditable spellCheck noValidate formAction encType enterKeyHint inputMode className dateTime hrefLang accessKey playsInline".split(
    " ",
  ),
);

export function scan(ts, rel, src, report = {}) {
  const isTest = /\.test\.tsx?$/.test(rel) || /(^|\/)test\//.test(rel);
  const tag = isTest ? "test" : "app";
  const hits = [];
  const sf = ts.createSourceFile(
    rel,
    src,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const hit = (idiom, n) => {
    if (!isTest) hits.push({ class: idiom, file: rel, line: lineOf(n) });
  };
  const tally = (label, n) => {
    report.bump?.(`${tag} ${label}`, rel);
    if (LABEL_CLASS[label]) hit(LABEL_CLASS[label], n);
  };
  const note = (k, s) => report.note?.(k, s);
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

  if (/solid-js|createSignal|createEffect/.test(src)) {
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
        tally(`createEffect`, n);
        const a0 = n.arguments[0];
        const usesOn = a0 && callName(a0) === "on";
        const body = usesOn ? a0.arguments[1] : a0;
        if (usesOn) tally(`createEffect: on() form`, n);
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
            tally(`createEffect: writes a setter in body`, n);
            if (!isTest) note("effect-writes", loc(n));
          }
          if (asyncy) tally(`createEffect: async or .then in body`, n);
          if (cleanup) tally(`createEffect: onCleanup inside`, n);
          if (nested) {
            tally(`createEffect: creates primitives inside`, n);
            if (!isTest) note("effect-nested", loc(n));
          }
          if (untr) tally(`createEffect: untrack inside`, n);
          if (invoke) tally(`createEffect: invoke/listen inside`, n);
          if (prev) tally(`createEffect: prev param`, n);
          if (!writes && !asyncy && !cleanup && !nested) tally(`createEffect: plain side effect (DOM or call)`, n);
        }
        if (fnDepth(n) === 0) tally(`createEffect: module level`, n);
        const k = enclosingKinds(n);
        if (k.inJsxAttr) {
          tally(`createEffect: inside JSX attribute callback`, n);
          note("effect-in-handler", loc(n));
        }
      }
      if (name === "createResource") {
        tally(`createResource`, n);
        const args = n.arguments;
        const second = args[1];
        const hasSource = second && (ts.isFunctionLike(second) || ts.isIdentifier(second));
        tally(`createResource: ${hasSource ? "source + fetcher" : "fetcher only"}`, n);
        const last = args[args.length - 1];
        if (last && ts.isObjectLiteralExpression(last)) {
          for (const p of last.properties) if (p.name) tally(`createResource option: ${p.name.getText()}`, n);
        }
        const decl = n.parent;
        if (ts.isVariableDeclaration(decl) && ts.isArrayBindingPattern(decl.name)) {
          const second = decl.name.elements[1];
          if (second && ts.isBindingElement(second) && ts.isObjectBindingPattern(second.name))
            for (const el of second.name.elements)
              tally(`createResource uses ${(el.propertyName || el.name).getText()}`, n);
          else if (second && !ts.isOmittedExpression(second)) tally(`createResource uses actions object`, n);
        }
        if (fnDepth(n) === 0) tally(`createResource: module level`, n);
      }
      if (name === "onMount") {
        tally(`onMount`, n);
        const b = n.arguments[0];
        if (b && ts.isFunctionLike(b) && b.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
          tally(`onMount: async`, n);
        if (b && scan(b, (x) => callName(x) === "onCleanup")) tally(`onMount: onCleanup inside`, n);
        if (
          b &&
          scan(b, (x) =>
            ["createEffect", "createMemo", "createRoot", "createSignal", "createResource"].includes(callName(x)),
          )
        ) {
          tally(`onMount: creates primitives inside`, n);
          if (!isTest) note("onmount-nested", loc(n));
        }
        if (
          b &&
          scan(b, (x) => {
            const cn = callName(x);
            return cn && isSetter(cn);
          })
        )
          tally(`onMount: writes a setter`, n);
      }
      if (name === "onCleanup") {
        tally(`onCleanup`, n);
        let p = n.parent,
          inRef = false;
        while (p) {
          if (ts.isJsxAttribute(p) && p.name.getText() === "ref") inRef = true;
          p = p.parent;
        }
        if (inRef) {
          tally(`onCleanup: inside ref callback`, n);
          note("cleanup-in-ref", loc(n));
        }
      }
      if (name === "createMemo") {
        tally(`createMemo`, n);
        const b = n.arguments[0];
        if (
          b &&
          scan(b, (x) => {
            const cn = callName(x);
            return cn && isSetter(cn);
          })
        ) {
          tally(`createMemo: writes a setter`, n);
          if (!isTest) note("memo-writes", loc(n));
        }
        if (n.arguments.length > 1) {
          tally(`createMemo: has 2nd/3rd arg`, n);
          if (!isTest) note("memo-args", loc(n));
        }
      }
      if (name === "createSignal") {
        tally(`createSignal`, n);
        if (fnDepth(n) === 0) tally(`createSignal: module level`, n);
        const a = n.arguments[0];
        if (a && (ts.isFunctionLike(a) || (ts.isIdentifier(a) && /^(noop|handler|fn|cb|callback)$/i.test(a.text)))) {
          tally(`createSignal: function as initial value`, n);
          note("signal-fn-init", loc(n));
        }
        if (n.typeArguments?.[0] && /=>/.test(n.typeArguments[0].getText())) {
          tally(`createSignal: type arg contains a function type`, n);
          note("signal-fn-type", loc(n));
        }
        if (n.arguments[1]) tally(`createSignal: has options`, n);
      }
      if (name === "createStore") {
        tally(`createStore`, n);
        if (fnDepth(n) === 0) tally(`createStore: module level`, n);
      }
      if (name === "createRoot") {
        tally(`createRoot`, n);
        if (fnDepth(n) === 0) tally(`createRoot: module level`, n);
        else if (!isTest) note("root-nested", loc(n));
      }
      if (name === "batch") tally(`batch`, n);
      if (name === "untrack") tally(`untrack`, n);
      if (name === "produce") tally(`produce`, n);
      if (name === "reconcile") tally(`reconcile`, n);
      if (name === "on" && !(n.parent && callName(n.parent) === "createEffect")) tally(`on() outside createEffect`, n);
      if (name && isSetter(name) && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0]))
        tally(`setter with string path first arg`, n);
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
              tally(`read of X() within 5 statements after setX()`, st[j]);
              if (!isTest) note("read-after-write", loc(st[j]));
              break;
            }
          }
        }
      }
      if (ts.isJsxAttribute(n)) {
        const an = n.name.getText();
        if (an === "classList") tally(`JSX classList`, n);
        if (an === "ref") {
          tally(`JSX ref`, n);
          const init = n.initializer;
          if (init && ts.isJsxExpression(init) && init.expression && ts.isFunctionLike(init.expression))
            tally(`JSX ref: inline callback`, n);
        }
        if (
          /^on[a-z]/.test(an) &&
          n.parent.parent &&
          ts.isIdentifier(n.parent.parent.tagName) &&
          /^[a-z]/.test(n.parent.parent.tagName.text)
        ) {
          tally(`JSX lowercase on* on native element`, n);
          note("lower-on", loc(n));
        }
        if (
          /^on[A-Z]/.test(n.name.getText()) &&
          n.initializer &&
          ts.isJsxExpression(n.initializer) &&
          n.initializer.expression &&
          ts.isConditionalExpression(n.initializer.expression)
        ) {
          tally(`JSX handler chosen by ternary (binds once in 2.0)`, n);
          note("handler-ternary", loc(n));
        }
        if (
          /^on[A-Z]/.test(an) &&
          n.initializer &&
          ts.isJsxExpression(n.initializer) &&
          n.initializer.expression &&
          ts.isArrayLiteralExpression(n.initializer.expression)
        )
          tally(`JSX handler tuple form`, n);
        if (
          (an === "value" || an === "checked") &&
          n.parent.parent &&
          ts.isIdentifier(n.parent.parent.tagName) &&
          /^(input|textarea|select)$/.test(n.parent.parent.tagName.text)
        )
          tally(`JSX controlled value/checked on input`, n);
        if (
          /^(aria-[a-z]+|draggable|spellcheck|contenteditable)$/.test(an) &&
          n.initializer &&
          ts.isJsxExpression(n.initializer) &&
          n.initializer.expression &&
          !ts.isStringLiteral(n.initializer.expression)
        )
          tally(`JSX enumerated attr with non-string value (${an.startsWith("aria-") ? "aria-*" : an})`, n);
      }
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const t = n.tagName.getText();
        if (t.endsWith(".Provider")) tally(`JSX X.Provider`, n);
        if (["Suspense", "ErrorBoundary", "Index", "Dynamic", "Portal", "For", "Show", "Switch", "Match"].includes(t))
          tally(`JSX <${t}>`, n);
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
                tally(`component destructures props in body`, n);
                note("props-destructure", loc(d));
              } else if (
                d.initializer &&
                ts.isPropertyAccessExpression(d.initializer) &&
                ts.isIdentifier(d.initializer.expression) &&
                d.initializer.expression.text === "props" &&
                !flagged
              ) {
                flagged = true;
                tally(`component reads props.x into a const at top of body`, d);
                note("props-top-read", loc(d));
              }
            }
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }

  const unwrap = (e) => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return e;
  };
  const isStringy = (e) =>
    ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || (ts.isIdentifier(e) && e.text === "undefined");
  const isProps = (e) => ts.isIdentifier(e) && (e.text === "props" || e.text === "local");
  const isPassThrough = (e, name) =>
    (ts.isElementAccessExpression(e) &&
      isProps(e.expression) &&
      ts.isStringLiteralLike(e.argumentExpression) &&
      e.argumentExpression.text === name) ||
    (ts.isPropertyAccessExpression(e) && isProps(e.expression) && e.name.text === name);
  const allowedValue = (value, name) => {
    const e = unwrap(value);
    if (ts.isConditionalExpression(e)) return allowedBranch(e.whenTrue) && allowedBranch(e.whenFalse);
    return (isStringy(e) && !(ts.isIdentifier(e) && e.text === "undefined")) || isPassThrough(e, name);
  };
  const allowedBranch = (value) => {
    const e = unwrap(value);
    return ts.isConditionalExpression(e) ? allowedBranch(e.whenTrue) && allowedBranch(e.whenFalse) : isStringy(e);
  };
  const hasReasonAbove = (n) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
    if (line === 0) return false;
    const above = src.split("\n")[line - 1].trim();
    return above.startsWith("//") || above.endsWith("*/");
  };
  const isDeferNow = (n) => {
    if (!ts.isCallExpression(n)) return false;
    const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : callName(n);
    if (ts.isPropertyAccessExpression(n.expression)) {
      const base = n.expression.expression;
      if (!ts.isIdentifier(base) || !["window", "globalThis", "self"].includes(base.text)) return false;
    }
    if (callee === "queueMicrotask") return true;
    if (callee !== "setTimeout") return false;
    const delay = n.arguments[1];
    return !delay || (ts.isNumericLiteral(delay) && Number(delay.text) === 0);
  };
  const isDetachedRoot = (n) => {
    let p = n.parent;
    if (p && ts.isReturnStatement(p)) p = p.parent?.parent;
    if (!p || (!ts.isArrowFunction(p) && !ts.isFunctionExpression(p))) return false;
    const call = p.parent;
    return (
      !!call &&
      callName(call) === "runWithOwner" &&
      call.arguments[0]?.kind === ts.SyntaxKind.NullKeyword &&
      call.arguments[1] === p
    );
  };
  const componentName = (n) => {
    if (ts.isFunctionDeclaration(n)) return n.name?.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent))
      return ts.isIdentifier(n.parent.name) ? n.parent.name.text : undefined;
    return undefined;
  };
  const hasJsx = (n) => {
    let found = false;
    (function v(x) {
      if (found) return;
      if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) found = true;
      else ts.forEachChild(x, v);
    })(n);
    return found;
  };

  (function guard(n) {
    if (ts.isJsxAttribute(n)) {
      if (ts.isJsxNamespacedName(n.name)) {
        const space = n.name.namespace.text;
        if (space === "use") hit("use-directive", n);
        if (space === "on" || space === "oncapture") hit("on-namespace", n);
      } else {
        const name = n.name.text;
        if (isEnumerated(name)) {
          const init = n.initializer;
          const value = init && ts.isJsxExpression(init) ? init.expression : init;
          if (!value || !allowedValue(value, name)) hit("boolean-attr", n);
        }
        const tagName = n.parent.parent.tagName;
        if (CAMEL_ATTRS.has(name) && ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text)) hit("camelcase-attr", n);
      }
    }
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isStringLiteral(n.name) ? isEnumerated(n.name.text) : ts.isIdentifier(n.name) && ENUMERATED.has(n.name.text))
    ) {
      if (!allowedValue(n.initializer, n.name.text)) hit("boolean-attr", n);
    }
    if (isDeferNow(n) && !hasReasonAbove(n)) hit("timing", n);
    if (callName(n) === "createRoot" && fnDepth(n) > 0 && !isDetachedRoot(n)) hit("nested-root", n);
    if (ts.isFunctionLike(n) && n.parameters?.[0] && ts.isObjectBindingPattern(n.parameters[0].name)) {
      const name = componentName(n);
      if (name && /^[A-Z]/.test(name) && n.body && hasJsx(n.body)) hit("destructured-props", n);
    }
    ts.forEachChild(n, guard);
  })(sf);

  return hits;
}
