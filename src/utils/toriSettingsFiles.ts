// No imports, deliberately: `lspClient.ts` owns `pathToUri` but pulls in
// CodeMirror, so importing it here would drag the editor into every bundle
// that asks which server claims a file.

/** One settings file: how the server recognizes it, and what describes it. */
export type ToriSettingsFile = {
  /** A `json/schemaAssociations` pattern. Written as a glob rather than an
   *  absolute path because the server prepends a leading `**` segment to every
   *  pattern it is given (`jsonSchemaService.js:41`), so an absolute path would
   *  be matched as a suffix anyway - and a glob says so rather than pretending
   *  otherwise. */
  fileMatch: string;
  /** Basename inside the bundled `resources/schemas` directory. */
  schema: string;
};

// Two settings schemas, not one: `editor` is a per-project map in the global
// file and the override block itself in a workspace file.
export const TORI_SETTINGS_FILES: ToriSettingsFile[] = [
  { fileMatch: "**/.config/tori/settings.json", schema: "tori-settings.schema.json" },
  { fileMatch: "**/.tori/settings.json", schema: "tori-workspace-settings.schema.json" },
  { fileMatch: "**/.tori/project.json", schema: "tori-project.schema.json" },
];

/** The suffix each pattern reduces to, which is what the server's leading `**`
 *  makes it mean. Derived rather than restated so the predicate below and the
 *  patterns above cannot drift into disagreeing about which files these are. */
const SUFFIXES = TORI_SETTINGS_FILES.map((f) => f.fileMatch.replace(/^\*\*/, ""));

// Opened as `jsonc`: Tori reads all of these with json5, and the JSON server
// errors on comments under every other id (`jsonServer.js:285`).
export function isToriSettingsFile(path: string): boolean {
  return SUFFIXES.some((suffix) => path.endsWith(suffix));
}
