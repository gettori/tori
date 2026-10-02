// What a Settings test answers a command it has no opinion about.
//
// Most of them hand every command the settings object, which is right for the
// store and wrong for the panes that read a list: `.filter` on an object throws
// in a resource, outside any test, and fails the run without failing a test.
import { DEFAULT_SETTINGS } from "../panels/Settings/settingsStore";

const LISTS = new Set(["lsp_health", "trusted_projects", "untrusted_projects"]);

export const unstubbed = (cmd: string): unknown => (LISTS.has(cmd) ? [] : DEFAULT_SETTINGS);
