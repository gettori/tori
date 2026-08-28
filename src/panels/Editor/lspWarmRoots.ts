// The warm-root LRU: a language server survives the switch away from its
// project, so switching back is a claim on a running server instead of a cold
// start and a re-index. Three, not unlimited: each root can hold a tsserver or
// a rust-analyzer, and the point is the worktrees being flipped between, not
// every project visited since launch. Most-recent last.
//
// **Its own module on purpose, not a section of `lspClient`.** That module is in
// an import cycle (`lspCodeActions` and `lspCodeLens` both import back into it),
// so `import("./lspClient")` can hand a caller the namespace before a single
// statement of its body has run. The retire is called through exactly that
// dynamic import on every project switch, and it read this list as a module-scope
// `const` of `lspClient`: hoisted function, unreachable state, a `ReferenceError`
// in its temporal dead zone. Moving the declarations up did not help, because in
// that state Vite's own import bindings are in the dead zone too. Nothing here
// imports anything in that cycle, so this module is fully evaluated before
// `lspClient`'s body begins and cannot be caught half-built.

import { isUnderPath } from "../../utils/pathScope";

const WARM_ROOTS = 3;
const rootLru: string[] = [];

/** Move a project to the warm end, returning what fell off. `ensureLspFor`
 *  touches too, so a start is warm for its own project by construction rather
 *  than by trusting the shell to have announced the switch first. */
export function touchWarmRoot(projectPath: string): string[] {
  const i = rootLru.indexOf(projectPath);
  if (i >= 0) rootLru.splice(i, 1);
  rootLru.push(projectPath);
  return rootLru.splice(0, Math.max(0, rootLru.length - WARM_ROOTS));
}

/** Whether a server root belongs to a still-warm project. A session's root can
 *  be a package below the project (monorepo), so this is containment, not
 *  equality. */
export function underWarmRoot(root: string): boolean {
  return rootLru.some((r) => root === r || isUnderPath(root, r));
}

/** Forget every warm project. What app teardown calls, with the servers. */
export function clearWarmRoots(): void {
  rootLru.length = 0;
}
