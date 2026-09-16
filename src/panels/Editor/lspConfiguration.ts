// Getting a server's `[settings]` table into the server.
//
// There are two ways to do that in LSP and they are not alternatives, because
// servers disagree about which one they read:
//
//   - **Push.** `workspace/didChangeConfiguration` carries the whole settings
//     object. `vscode-json-languageserver` reads it straight off the
//     notification (`out/jsonServer.js:161`).
//   - **Pull.** The server sends `workspace/configuration` naming the sections
//     it wants, and the client answers. `yaml-language-server` answers the
//     *push* by doing exactly this (`settingsHandlers.js:34`), so for that one
//     the push is only a doorbell and the pull is what carries the values.
//
// A server that never receives its configuration is not obviously broken, which
// is what makes this worth spelling out: yaml-language-server defaults
// `schemaStore.enable` to true, but only builds the store inside the handler
// that a configuration arriving triggers. Send nothing and it keeps a default
// it never applies.
//
// So Tori does both, from one table, and a config author does not have to know
// which server is which.

/** One entry of a `workspace/configuration` request. */
export type ConfigurationItem = { section?: unknown; scopeUri?: unknown };

/**
 * Follow a dotted section name into the settings table.
 *
 * Dotted because LSP section names are paths: a server may ask for `yaml` or
 * for `yaml.format`, and both have to find the same table.
 */
function sectionValue(settings: Record<string, unknown>, section: string): unknown {
  let at: unknown = settings;
  for (const part of section.split(".")) {
    if (at === null || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[part];
    if (at === undefined) return null;
  }
  return at ?? null;
}

/**
 * Answer one `workspace/configuration` request from a server's own settings.
 *
 * One value per requested item, in order, which the protocol requires: the
 * server reads the reply positionally, so a short array silently shifts every
 * section after the gap onto the wrong one.
 *
 * A section this config says nothing about is answered `null`, not omitted.
 * That is the honest answer and the one servers expect - `yaml-language-server`
 * asks for `http`, `editor` and `files` alongside `yaml`, and Tori has an
 * opinion about none of them.
 *
 * `scopeUri` is ignored. Tori's settings are per server, not per folder, and
 * answering the same value for every scope is exactly right until they are not.
 */
export function configurationFor(settings: Record<string, unknown> | null, params: unknown): unknown[] {
  const items = (params as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item: ConfigurationItem) => {
    // No section means the whole configuration, per the specification.
    if (typeof item?.section !== "string") return settings ?? null;
    return settings ? sectionValue(settings, item.section) : null;
  });
}

/**
 * `workspace.configuration`, and the notification's own block.
 *
 * `configuration` is a promise Tori now keeps: a client that declares it and
 * then answers `-32601` tells a conformant server it lied, and the server's
 * reasonable response is to stop asking. The library declares neither, which is
 * why this is a capability block rather than a line in an existing one.
 */
export const configurationClientCapabilities = {
  clientCapabilities: {
    workspace: {
      configuration: true,
      didChangeConfiguration: { dynamicRegistration: false },
    },
  },
};
