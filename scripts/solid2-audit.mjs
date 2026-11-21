#!/usr/bin/env node
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/solid2-audit.mjs <file>...");
  process.exit(2);
}

const REMOVED = new Set(["on", "onMount"]);
let hits = 0;

for (const file of files) {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  const imported = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "solid-js") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (REMOVED.has(name)) imported.set(element.name.text, name);
    }
  }

  const report = (node, what) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    console.log(`${file}:${line + 1}: ${what}`);
    hits++;
  };

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "classList") report(node, "classList");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported.has(node.expression.text)) {
      report(node, `${imported.get(node.expression.text)}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

process.exit(hits > 0 ? 1 : 0);
