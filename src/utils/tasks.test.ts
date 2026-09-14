import { describe, it, expect } from "vitest";
import {
  loadTasks,
  packageRunner,
  parseJustRecipes,
  parseMakeTargets,
  parsePackageScripts,
  taskTab,
  type Task,
} from "./tasks";

// Three hand-written formats read as text, so what is pinned here is the line
// each one turns into and, mostly, the lines it must *not*: a Makefile's recipe
// bodies and a justfile's assignments both contain colons, and a parser that
// takes them offers to run things that are not tasks.

const PKG = JSON.stringify({
  name: "app",
  scripts: { dev: "vite", "test:watch": "vitest", build: "tsc && vite build" },
});

const MAKEFILE = [
  "# a comment",
  ".PHONY: build test",
  "CC := gcc",
  "FLAGS = -O2",
  "",
  "build: deps",
  "\techo one: two",
  "\tcd src && make sub",
  "",
  "test check: build",
  "\tgo test ./...",
  "",
  "%.o: %.c",
  "\t$(CC) -c $<",
].join("\n");

const JUSTFILE = [
  "# recipes",
  'export VERSION := "1.2"',
  "",
  "build:",
  "    cargo build",
  "",
  "deploy env='staging':",
  "    ./deploy.sh {{env}}",
  "",
  "_private:",
  "    echo hidden",
].join("\n");

describe("package.json scripts", () => {
  it("runs each script with the project's own package manager", () => {
    expect(parsePackageScripts(PKG, "pnpm")).toEqual([
      { id: "npm:dev", name: "dev", source: "npm", command: "pnpm run dev", file: "package.json", line: 1 },
      {
        id: "npm:test:watch",
        name: "test:watch",
        source: "npm",
        command: "pnpm run test:watch",
        file: "package.json",
        line: 1,
      },
      { id: "npm:build", name: "build", source: "npm", command: "pnpm run build", file: "package.json", line: 1 },
    ]);
  });

  it("keeps the order the scripts block is written in", () => {
    // The daily ones are usually at the top, and sorting throws that away.
    expect(parsePackageScripts(PKG, "npm").map((t) => t.name)).toEqual(["dev", "test:watch", "build"]);
  });

  it("reads a package.json mid-edit as having no scripts yet, not as an error", () => {
    expect(parsePackageScripts("{ \"scripts\": {", "npm")).toEqual([]);
    expect(parsePackageScripts("{}", "npm")).toEqual([]);
    expect(parsePackageScripts('{"scripts":[]}', "npm")).toEqual([]);
  });

  it("quotes a script name the shell would read as syntax", () => {
    // The name comes out of a file in the project and the line is typed into a
    // live shell, so it has to arrive as one word.
    const [t] = parsePackageScripts('{"scripts":{"build; rm -rf ~":"x"}}', "npm");
    expect(t.command).toBe("npm run 'build; rm -rf ~'");
  });

  it("names the manager from the lockfile, defaulting to npm", () => {
    expect(packageRunner(["package.json", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(packageRunner(["yarn.lock"])).toBe("yarn");
    expect(packageRunner(["package.json"])).toBe("npm");
  });
});

describe("Makefile targets", () => {
  it("takes the column-zero rules, both names of a two-name rule included", () => {
    expect(parseMakeTargets(MAKEFILE).map((t) => t.name)).toEqual(["build", "test", "check"]);
  });

  it("runs one with make", () => {
    expect(parseMakeTargets("build:\n\tcc x.c")).toEqual([
      { id: "make:build", name: "build", source: "make", command: "make build", file: "Makefile", line: 1 },
    ]);
  });

  it("leaves out what nobody runs by name", () => {
    // `.PHONY` is a declaration, `%.o` is a pattern, `CC := gcc` is an
    // assignment whose colon looks exactly like a rule's, and an indented line
    // is a recipe body whose shell can contain anything.
    const names = parseMakeTargets(MAKEFILE).map((t) => t.name);
    expect(names).not.toContain(".PHONY");
    expect(names).not.toContain("CC");
    expect(names).not.toContain("FLAGS");
    expect(names.some((n) => n.includes("%"))).toBe(false);
    expect(names).not.toContain("echo one");
  });

  it("yields nothing for a Makefile of only variables", () => {
    expect(parseMakeTargets("CC := gcc\nFLAGS ?= -O2\n")).toEqual([]);
  });
});

describe("justfile recipes", () => {
  it("takes the recipe names, parameters and all", () => {
    expect(parseJustRecipes(JUSTFILE).map((t) => t.name)).toEqual(["build", "deploy"]);
  });

  it("runs one with just", () => {
    expect(parseJustRecipes("build:\n    cargo build")).toEqual([
      { id: "just:build", name: "build", source: "just", command: "just build", file: "justfile", line: 1 },
    ]);
  });

  it("leaves out assignments and the recipes just itself hides", () => {
    // `just --list` hides a leading-underscore recipe, and a list that offers
    // one offers something the project decided not to.
    const names = parseJustRecipes(JUSTFILE).map((t) => t.name);
    expect(names).not.toContain("VERSION");
    expect(names).not.toContain("_private");
  });
});

describe("the tab a task runs in", () => {
  const task: Task = { id: "npm:test", name: "test", source: "npm", command: "npm run test" };

  it("is a login shell carrying the command as init, not a direct spawn", () => {
    // The whole point of the seam: `init` is delivered backend-once, so a
    // remount re-subscribes instead of typing the command a second time, and a
    // login shell gives the task the PATH the user's own terminal has.
    const tab = taskTab("/proj", task, 1);
    expect(tab.kind).toBe("task");
    expect(tab.init).toBe("npm run test\n");
    expect(tab.program).toBe("");
    expect(tab.cwd).toBe("/proj");
  });

  it("gives each run its own tab, named so they can be told apart", () => {
    // A shell can only take one `init`, so a re-run cannot reuse the tab: it
    // would either need a `pty_write` or silently do nothing.
    expect(taskTab("/proj", task, 1).id).not.toBe(taskTab("/proj", task, 2).id);
    expect(taskTab("/proj", task, 1).title).toBe("test");
    expect(taskTab("/proj", task, 2).title).toBe("test (2)");
  });

  it("keeps two workspaces' runs of the same task apart", () => {
    expect(taskTab("/a", task, 1).id).not.toBe(taskTab("/b", task, 1).id);
  });
});

describe("reading a workspace", () => {
  const dir = (...names: string[]) => async () => names.map((name) => ({ name }));
  const files = (map: Record<string, string>) => async (path: string) => {
    const hit = map[path];
    if (hit === undefined) throw new Error(`ENOENT ${path}`);
    return hit;
  };

  it("collects all three formats, npm first", async () => {
    const tasks = await loadTasks(
      "/proj",
      dir("package.json", "pnpm-lock.yaml", "Makefile", "justfile"),
      files({
        "/proj/package.json": '{"scripts":{"dev":"vite"}}',
        "/proj/Makefile": "build:\n\tcc",
        "/proj/justfile": "fmt:\n    cargo fmt",
      }),
    );
    expect(tasks.map((t) => t.command)).toEqual(["pnpm run dev", "make build", "just fmt"]);
  });

  it("yields an empty list for a workspace that defines none", async () => {
    expect(await loadTasks("/proj", dir("src", "README.md"), files({}))).toEqual([]);
  });

  it("reads only the files the listing says are there", async () => {
    // A project with no Makefile should cost no failed read and no swallowed
    // error, so the listing is what decides rather than a read that throws.
    const asked: string[] = [];
    await loadTasks(
      "/proj",
      dir("package.json"),
      async (path) => {
        asked.push(path);
        return '{"scripts":{"dev":"vite"}}';
      },
    );
    expect(asked).toEqual(["/proj/package.json"]);
  });

  it("refuses to answer at all when the listing fails", async () => {
    // An empty list here would be read as "this project defines no tasks",
    // which is a claim about the project rather than about the read.
    await expect(
      loadTasks(
        "/gone",
        async () => {
          throw new Error("ENOENT");
        },
        files({}),
      ),
    ).rejects.toThrow("ENOENT");
  });

  it("still answers when one named file cannot be opened", async () => {
    // A file the listing just named and that will not open is one task source
    // missing, not an unreadable project.
    const tasks = await loadTasks(
      "/proj",
      dir("package.json", "Makefile"),
      files({ "/proj/Makefile": "build:\n\tcc" }),
    );
    expect(tasks.map((t) => t.name)).toEqual(["build"]);
  });
});
