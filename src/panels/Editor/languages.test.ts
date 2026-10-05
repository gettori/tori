import { describe, it, expect } from "vite-plus/test";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { languageForPath, tokenLines } from "./syntaxLines";

describe("languageForPath", () => {
  it("keeps the grammars it had before language-data", async () => {
    const before: Record<string, string | null> = {
      "/r/a.md": "markdown",
      "/r/a.markdown": "markdown",
      "/r/a.css": "css",
      "/r/a.html": "html",
      "/r/a.htm": "html",
      "/r/a.rs": "rust",
      "/r/a.py": "python",
      "/r/A.PY": "python",
      "/r/a.yaml": "yaml",
      "/r/a.yml": "yaml",
      "/r/a.toml": "toml",
      "/r/a.sh": "shell",
      "/r/a.bash": "shell",
      "/r/a.zsh": "shell",
      "/r/.zshrc": "shell",
      "/r/.bashrc": "shell",
      "/r/some.ts/README": null,
    };
    const now: Record<string, string | null> = {};
    for (const path of Object.keys(before)) now[path] = (await languageForPath(path))?.name ?? null;
    expect(now).toEqual(before);
  });

  it("serves JavaScript, TypeScript and JSON from the eager packs", async () => {
    const same = async (path: string, expected: { language: unknown }) =>
      expect(await languageForPath(path), path).toBe(expected.language);
    await same("/r/a.ts", javascript({ typescript: true }));
    await same("/r/a.mts", javascript({ typescript: true }));
    await same("/r/a.cts", javascript({ typescript: true }));
    await same("/r/a.tsx", javascript({ typescript: true, jsx: true }));
    await same("/r/a.js", javascript());
    await same("/r/a.mjs", javascript());
    await same("/r/a.cjs", javascript());
    await same("/r/a.jsx", javascript({ jsx: true }));
    await same("/r/a.json", json());
  });

  it("highlights languages that came with language-data", async () => {
    const keyword = async (path: string, text: string, word: string) => {
      const lang = await languageForPath(path);
      expect(lang, path).not.toBeNull();
      const span = tokenLines(text, lang!)
        .flat()
        .find((s) => s.text === word);
      expect(span?.cls, path).toBeTruthy();
    };
    await keyword("/r/main.go", "package main\n", "package");
    await keyword("/r/a.rb", "def x\nend\n", "def");
    await keyword("/r/q.sql", "SELECT 1;\n", "SELECT");
    await keyword("/r/Dockerfile", "FROM node:22\n", "FROM");
  });
});
