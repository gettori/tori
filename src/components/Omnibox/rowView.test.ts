import { describe, it, expect } from "vite-plus/test";
import { rowView } from "./rowView";

describe("which slots each kind of row fills", () => {
  it("draws a file with its file glyph and the matched part of its path", () => {
    const view = rowView({
      kind: "file",
      id: "file:/repo:src/App.tsx",
      label: "src/App.tsx",
      file: "App.tsx",
      marks: [{ start: 4, end: 7 }],
    });
    expect(view).toEqual({
      icon: { kind: "file", name: "App.tsx" },
      title: "src/App.tsx",
      marks: [{ start: 4, end: 7 }],
      subtitle: undefined,
    });
  });

  it("gives a command its group glyph, its key chips, and a name for them", () => {
    const view = rowView({
      kind: "command",
      id: "toggle-terminal",
      label: "Toggle Terminal",
      group: "view",
      keys: ["\u2318", "\u2325", "J"],
    });
    expect(view.icon).toEqual({ kind: "group", group: "view" });
    expect(view.keys).toEqual({ chips: ["\u2318", "\u2325", "J"], spoken: "Command Option J" });
    expect(view.marks).toEqual([]);
  });

  it("falls back to the group's name when a command has no secondary text", () => {
    expect(rowView({ kind: "command", id: "a", label: "Fetch", group: "git" }).subtitle).toBe("Git");
    expect(rowView({ kind: "command", id: "b", label: "Push", group: "git", sub: "To origin" }).subtitle).toBe(
      "To origin",
    );
  });

  it("puts a refused command's reason where its secondary text was", () => {
    const view = rowView({
      kind: "command",
      id: "save",
      label: "Save",
      group: "editor",
      sub: "Write the file",
      disabled: "No file open",
    });
    expect(view.subtitle).toBe("No file open");
  });

  it("draws a symbol with its kind's glyph and its container", () => {
    const view = rowView({ kind: "symbol", id: "s", label: "render", symbolKind: 12, sub: "Omnibox" });
    expect(view.icon).toEqual({ kind: "symbol", symbolKind: 12 });
    expect(view.subtitle).toBe("Omnibox");
    expect(view.keys).toBeUndefined();
  });

  it("draws the line row with the line glyph and the file it goes to", () => {
    const view = rowView({ kind: "line", id: "line:12", label: "Go to line 12", sub: "App.tsx" });
    expect(view.icon).toEqual({ kind: "mode", mode: "line" });
    expect(view.subtitle).toBe("App.tsx");
  });

  it("shows a mode's prefix as a key chip, and none for the home row", () => {
    const typed = rowView({ kind: "help", id: "help:command", label: "Commands", mode: "command", prefix: ">" });
    expect(typed.icon).toEqual({ kind: "mode", mode: "command" });
    expect(typed.keys).toEqual({ chips: [">"], spoken: ">" });

    const home = rowView({ kind: "help", id: "help:file", label: "Files", mode: "file", prefix: "" });
    expect(home.keys).toBeUndefined();
  });
});
