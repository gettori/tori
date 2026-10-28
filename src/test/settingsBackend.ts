// What a Settings test answers a command it has no opinion about.
//
// Most of them hand every command the settings object, which is right for the
// store and wrong for the panes that read a list: `.filter` on an object throws
// in a resource, outside any test, and fails the run without failing a test.
import { DEFAULT_SETTINGS } from "../panels/Settings/settingsStore";

const LISTS = new Set(["lsp_health", "trusted_projects", "untrusted_projects", "speech_voices"]);

const NO_VOICE = { installed: false, model: null, downloading: null, sizes: [] };

export const unstubbed = (cmd: string): unknown =>
  cmd === "speech_status" ? NO_VOICE : LISTS.has(cmd) ? [] : DEFAULT_SETTINGS;
