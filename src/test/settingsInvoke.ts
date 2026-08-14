// Shared `invoke` stubs for suites that render the Settings panel.
//
// Settings renders `AgentsSection`, which reads the ACP launch catalogue from
// two `createResource`s. Every Settings suite mocks `invoke` with a catch-all
// returning `DEFAULT_SETTINGS`, and a settings object is not an array, so
// `(rows() ?? []).filter(...)` threw *inside the resource* - surfacing as an
// unhandled rejection after the test that caused it had already passed. 42 of
// them across four suites, none of which had any interest in the catalogue.
//
// A catch-all answering every command with one shape is the underlying hazard,
// and this does not fix that. What it fixes is the case where the wrong shape
// is not merely useless but throws, for a section a suite renders only because
// it is on the same panel as the thing under test.

/** What a suite that never set up a catalogue actually has: no rows, no
 *  provenance. Both are `Show`-gated, so the section renders as absent. */
const CATALOG: Record<string, unknown> = {
  acp_catalog: [],
  acp_catalog_source: null,
};

type InvokeHandler = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Wraps a suite's own `invoke` handler so the catalogue commands answer with an
 * empty catalogue instead of falling through to its catch-all.
 *
 * A suite that asserts *about* the catalogue names the commands itself and does
 * not use this - see `agentsCatalog.test.tsx`.
 */
export function withAcpCatalog(handler: InvokeHandler): InvokeHandler {
  return async (cmd, args) => (cmd in CATALOG ? CATALOG[cmd] : handler(cmd, args));
}
