// The two files Sway writes its own settings to, and the schema describing each.
//
// Sway ships schemas for its own settings for the reason it feeds the JSON
// server SchemaStore's catalog: the server validates a JSON file against a
// schema and has no idea which schema, so a settings file nobody told it about
// is a settings file with no completion and no spell-check on its keys.
//
// **No imports, deliberately.** `utils/lspServers.ts` needs the path rule to
// decide a language id, and `panels/Editor/lspClient.ts` needs it to build the
// associations. The latter owns `pathToUri` but sits behind the editor's lazy
// boundary and pulls in CodeMirror, so importing it from `utils` would drag the
// editor into every bundle that asks which server claims a file. The rule is
// what is shared; the wire form is built where the wire is.

/** One settings file: how the server recognizes it, and what describes it. */
export type SwaySettingsFile = {
  /** A `json/schemaAssociations` pattern. Written as a glob rather than an
   *  absolute path because the server prepends a leading `**` segment to every
   *  pattern it is given (`jsonSchemaService.js:41`), so an absolute path would
   *  be matched as a suffix anyway - and a glob says so rather than pretending
   *  otherwise. */
  fileMatch: string;
  /** Basename inside the bundled `resources/schemas` directory. */
  schema: string;
};

/**
 * Both files, each with the schema that describes it.
 *
 * They are separate schemas rather than one because the two shapes collide:
 * `editor` in the global file is the per-project override *map*, keyed by
 * project path, while `editor` in a workspace file is the override block
 * itself. One schema covering both would describe whichever it chose and
 * misreport the other.
 */
export const SWAY_SETTINGS_FILES: SwaySettingsFile[] = [
  { fileMatch: "**/.config/sway/settings.json", schema: "sway-settings.schema.json" },
  { fileMatch: "**/.sway/settings.json", schema: "sway-workspace-settings.schema.json" },
];

/** The suffix each pattern reduces to, which is what the server's leading `**`
 *  makes it mean. Derived rather than restated so the predicate below and the
 *  patterns above cannot drift into disagreeing about which files these are. */
const SUFFIXES = SWAY_SETTINGS_FILES.map((f) => f.fileMatch.replace(/^\*\*/, ""));

/**
 * Is this one of Sway's own settings files?
 *
 * Used to open them as `jsonc`. Both are read with json5 (`settings.rs:2`,
 * `workspace_settings.rs:44`), so a comment in one is supported and not a
 * mistake - but the JSON server reports comments as errors for every language
 * id except `jsonc` (`jsonServer.js:285`), which would put a red squiggle on a
 * line Sway itself reads without complaint.
 *
 * A suffix match, not an absolute path: `settings.rs` builds the global path
 * from the home directory, and a test that had to know the home directory would
 * be testing the machine it ran on.
 */
export function isSwaySettingsFile(path: string): boolean {
  return SUFFIXES.some((suffix) => path.endsWith(suffix));
}
