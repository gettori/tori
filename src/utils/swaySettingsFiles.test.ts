import { describe, it, expect } from "vitest";
import { isSwaySettingsFile, SWAY_SETTINGS_FILES } from "./swaySettingsFiles";
import { languageIdFor, type LspServer } from "./lspServers";

/** The bundled JSON server, as `lsp_registry` reports it. Only the two fields
 *  the language-id rule reads are load-bearing here. */
const json: LspServer = {
  id: "json",
  label: "JSON",
  languages: { json: "json", jsonc: "jsonc" },
  root_markers: [".git"],
  request_timeout_ms: 20000,
  launch: { kind: "bundled_node", entry: "resources/lsp/x", args: ["--stdio"] },
  initialization_options: null,
  settings: null,
  schema_associations: true,
  verified_against: null,
  source: "bundled:json",
};

describe("recognizing Sway's own settings files", () => {
  it("knows both of them from the path alone", () => {
    // From the path, not from the home directory: the global file's real
    // location is built from `dirs::home_dir()`, and a test that had to know
    // that would be asserting about the machine it happened to run on.
    expect(isSwaySettingsFile("/Users/x/.config/sway/settings.json")).toBe(true);
    expect(isSwaySettingsFile("/repos/app/.sway/settings.json")).toBe(true);
  });

  it("is not fooled by a path that merely resembles one", () => {
    for (const path of [
      "/repos/app/settings.json", // the name alone is not the claim
      "/repos/app/.sway/other.json",
      "/repos/app/x.sway/settings.json", // `.sway` is a segment, not a suffix
      "/repos/app/.config/sway/cache/schemastore-catalog.json",
      "/repos/app/.vscode/settings.json",
    ]) {
      expect(isSwaySettingsFile(path), path).toBe(false);
    }
  });

  it("recognizes exactly the files it asks the server to match", () => {
    // The predicate and the patterns are one rule spelled twice - once for
    // Sway, once for the server - so this is what stops them drifting apart.
    // The server prepends a leading `**` to every pattern, which is what makes
    // dropping it here the same question.
    for (const { fileMatch } of SWAY_SETTINGS_FILES) {
      expect(fileMatch.startsWith("**/"), fileMatch).toBe(true);
      expect(isSwaySettingsFile(`/somewhere${fileMatch.slice(2)}`), fileMatch).toBe(true);
    }
  });

  it("gives each file its own schema", () => {
    // Not one schema for both: `editor` means the per-project override map in
    // the global file and the override block itself in a workspace file, so a
    // shared schema would misreport whichever it was not written for.
    const schemas = SWAY_SETTINGS_FILES.map((f) => f.schema);
    expect(new Set(schemas).size).toBe(schemas.length);
  });
});

describe("what language id a settings file opens as", () => {
  it("opens Sway's settings files as jsonc, because a comment in one is legal", () => {
    // Both are read with json5 (`settings.rs:2`, `workspace_settings.rs:44`),
    // and the server errors on comments under every id but `jsonc`. Without
    // this the file Sway itself reads happily gets a red squiggle per comment.
    expect(languageIdFor(json, "/Users/x/.config/sway/settings.json")).toBe("jsonc");
    expect(languageIdFor(json, "/repos/app/.sway/settings.json")).toBe("jsonc");
  });

  it("leaves every other .json file as json, where a comment really is an error", () => {
    expect(languageIdFor(json, "/repos/app/package.json")).toBe("json");
    expect(languageIdFor(json, "/repos/app/.vscode/settings.json")).toBe("json");
  });

  it("never offers an id the server did not advertise", () => {
    // A server claiming `.json` without speaking `jsonc` would be handed an id
    // it never declared, and is entitled to do nothing with it.
    const jsonOnly: LspServer = { ...json, languages: { json: "json" } };
    expect(languageIdFor(jsonOnly, "/Users/x/.config/sway/settings.json")).toBe("json");
  });

  it("still claims nothing for a file no server covers", () => {
    expect(languageIdFor(json, "/repos/app/main.rs")).toBe(null);
    expect(languageIdFor(json, "/repos/app/README")).toBe(null);
  });
});
