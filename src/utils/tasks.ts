// The one-line commands a project already defines, so running one is a pick
// rather than a retyped shell line.
//
// Three formats, chosen because they are the ones a project *declares* rather
// than documents: npm scripts, Make targets, just recipes. Read as text rather
// than shelled out to (`npm run`, `make -qp`, `just --list`), because the list
// is wanted before anyone has decided to run anything, and three subprocesses
// per project open is a real cost buying a marginally better parse.
//
// Pure and DOM-free apart from `loadTasks`, which is the one function that
// touches the backend, so the parsing rules test without a workspace on disk.

import type { OpenTerminal } from "./events";

export type TaskSource = "npm" | "make" | "just";

/** One runnable task. */
export type Task = {
  /** Stable within a workspace. Source-qualified because a `Makefile` and a
   *  `package.json` can both define `test`, and they are two different things
   *  that must not collapse onto one row or one tab. */
  id: string;
  name: string;
  source: TaskSource;
  /** The shell line that runs it, ready to be typed. */
  command: string;
};

/** Which lockfile means which runner. First match wins, in this order, so a
 *  repo carrying two lockfiles resolves the same way every time. */
const LOCKFILES: { lock: string; runner: string }[] = [
  { lock: "pnpm-lock.yaml", runner: "pnpm" },
  { lock: "yarn.lock", runner: "yarn" },
  { lock: "bun.lockb", runner: "bun" },
];

const MAKEFILES = ["Makefile", "makefile", "GNUmakefile"];
const JUSTFILES = ["justfile", "Justfile", ".justfile"];

/**
 * The package manager this project's scripts should be run with.
 *
 * From the lockfile rather than a setting: the lockfile is the project's own
 * answer, and `npm run dev` in a pnpm repo is not a preference someone got
 * wrong, it is a command that installs the wrong tree.
 */
export function packageRunner(entries: readonly string[]): string {
  const found = LOCKFILES.find((l) => entries.includes(l.lock));
  return found ? found.runner : "npm";
}

/** Quote a name the shell would otherwise read as syntax. These names come out
 *  of a file in the project and the line is typed into a live shell, so a
 *  script called `build; rm -rf ~` has to arrive as one word. */
function shellArg(name: string): string {
  return /^[A-Za-z0-9_.:@+\-/]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`;
}

function task(source: TaskSource, name: string, command: string): Task {
  return { id: `${source}:${name}`, name, source, command };
}

/**
 * `package.json`'s `scripts`, in the order they are written.
 *
 * Declaration order, not alphabetical: a `scripts` block is usually written
 * with the ones you run all day at the top, and sorting it discards that.
 */
export function parsePackageScripts(json: string, runner: string): Task[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A package.json mid-edit is not an error worth a panel full of red; it is
    // a file that has no scripts *yet*.
    return [];
  }
  const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const out: Task[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== "string" || !name) continue;
    out.push(task("npm", name, `${runner} run ${shellArg(name)}`));
  }
  return out;
}

/**
 * A Makefile's targets.
 *
 * Only column-zero rules: an indented line is a recipe body, and a recipe body
 * full of shell can contain a colon. Assignments (`FOO := bar`) are skipped by
 * the `=`-after-colon guard, pattern rules (`%.o:`) and dot targets (`.PHONY`)
 * because neither is something a person runs by name.
 */
export function parseMakeTargets(text: string): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line || /^[\s#]/.test(line)) continue;
    const m = /^([^:=]+?)\s*::?(?!=)/.exec(line);
    if (!m) continue;
    for (const name of m[1].trim().split(/\s+/)) {
      if (!name || name.startsWith(".") || name.includes("%") || name.includes("$")) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(task("make", name, `make ${shellArg(name)}`));
    }
  }
  return out;
}

/**
 * A justfile's recipes.
 *
 * Same column-zero rule as Make. `just` reads `name := value` as an assignment
 * and `name arg:` as a recipe taking a parameter, so the name is the first
 * token and everything up to the colon is the signature. Recipes named with a
 * leading `_` are private (`just --list` hides them), and a task list that
 * offers them offers something the project decided not to.
 */
export function parseJustRecipes(text: string): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line || /^[\s#[@]/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:(?!=)/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith("_") || seen.has(name)) continue;
    seen.add(name);
    out.push(task("just", name, `just ${shellArg(name)}`));
  }
  return out;
}

/**
 * The tab that runs a task.
 *
 * A **login-shell** tab carrying the command line as `init`, not a `command`
 * tab spawning the program directly, and never a `pty_write` after the spawn.
 * `pty_spawn` delivers `init` backend-once and is idempotent, so remounting a
 * running task's tab re-subscribes to the live process instead of typing the
 * command a second time. A login shell also means the task sees the same PATH,
 * aliases and version manager the user's own terminal does.
 *
 * The tab id carries the run number, so a re-run is a new tab with its own
 * output rather than a second `init` into a shell that can only ever take one.
 */
export function taskTab(root: string, t: Task, run: number): OpenTerminal {
  return {
    id: `task:${root}:${t.id}#${run}`,
    title: run > 1 ? `${t.name} (${run})` : t.name,
    cwd: root,
    // Shell-hosted, so the backend picks the login shell; `program` is what a
    // plain shell tab passes for the same reason (Terminal.tsx `newShell`).
    program: "",
    args: [],
    kind: "task",
    init: `${t.command}\n`,
  };
}

/** What `fs_read_dir` reports, narrowed to what this module reads. */
type DirEntry = { name: string };

/**
 * Every task this workspace defines.
 *
 * One directory listing decides what to read, so a project with no `Makefile`
 * costs no failed read and no error to swallow, and the same listing is what
 * names the package manager.
 *
 * A listing that fails is **not** swallowed: an empty list here would be read as
 * "this project defines no tasks", which is a claim about the project rather
 * than about the read. Each individual file read is forgiving, since a file the
 * listing just named and cannot be opened is one task source missing, not an
 * unreadable project.
 */
export async function loadTasks(
  root: string,
  readDir: (path: string) => Promise<DirEntry[]>,
  readFile: (path: string) => Promise<string>,
): Promise<Task[]> {
  const names = ((await readDir(root)) ?? []).map((e) => e.name);
  const read = (file: string) => readFile(`${root}/${file}`).catch(() => "");
  const out: Task[] = [];
  if (names.includes("package.json")) {
    out.push(...parsePackageScripts(await read("package.json"), packageRunner(names)));
  }
  const makefile = MAKEFILES.find((f) => names.includes(f));
  if (makefile) out.push(...parseMakeTargets(await read(makefile)));
  const justfile = JUSTFILES.find((f) => names.includes(f));
  if (justfile) out.push(...parseJustRecipes(await read(justfile)));
  return out;
}
