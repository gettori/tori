const { scan } = require("./solid2-idioms.mjs");
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
const guarded = {};
for (const f of files) {
  const rel = path.relative(root, f);
  for (const found of scan(ts, rel, fs.readFileSync(f, "utf8"), { bump, note })) {
    (guarded[found.class] ||= { n: 0, files: new Set() }).n++;
    guarded[found.class].files.add(found.file);
  }
}
const keys = Object.keys(c).sort();
for (const k of keys) console.log(`${k}\t${c[k].n}\t${c[k].files.size} files`);
console.log("\nGUARD");
for (const k of Object.keys(guarded).sort()) console.log(`${k}\t${guarded[k].n}\t${guarded[k].files.size} files`);
console.log("\nEXAMPLES");
for (const k of Object.keys(ex)) console.log(k + ": " + ex[k].join(", "));
