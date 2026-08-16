// What a harness said it can run, as the backend cached it.
//
// Mirrors `src-tauri/src/catalog_probe.rs`. The rows are deliberately the same
// shape as a live handshake's `ChatModelInfo`: the backend flattens it, so a
// cached row and a live row are the same JSON and a picker can read one where it
// reads the other. That is what makes "live wins, cache fills in before a
// session exists" a swap of source rather than a swap of shape.
import type { ChatAccount, ChatModeInfo, ChatModelInfo } from "./chatTypes";

// Which of the three things a harness's catalogue currently is.
//
// `neverProbed` is not an error and not an empty catalogue: it is the state of a
// harness nobody has asked yet, and it renders as no answer rather than as zero.
export type CatalogState = "neverProbed" | "failed" | "probed";

// Why a probe did not produce a catalogue. `unsupported` is a fact about Sway,
// not about the binary, so a surface must not render it as the harness failing.
export type ProbeFailureReason = "spawnFailed" | "timedOut" | "signedOut" | "noAnswer" | "unsupported";

export type ProbeFailure = {
  reason: ProbeFailureReason;
  // The harness's own words where there are any. Empty rather than invented.
  detail: string;
  atMs: number;
};

export type CatalogModel = ChatModelInfo & {
  // This row came from the user's own harness configuration rather than the
  // harness's catalogue. Still not something Sway invented, but not something it
  // can confirm either: such a row carries an **empty `resolvedModel`**, because
  // the configured string is passed to the CLI unresolved. Anything deduping by
  // that field has to fall back to `value`, or every user-configured row
  // collapses into one.
  userConfigured?: boolean;
};

export type Catalogue = {
  // The binary version at the moment of the probe. Null is the version-unknown
  // case, which is re-checked only when the user asks.
  version: string | null;
  probedAtMs: number;
  models: CatalogModel[];
  modes: ChatModeInfo[];
  // The agent's own config options, verbatim. Empty for claude, which publishes
  // none. Typed loosely here because nothing reads them yet.
  options?: unknown[];
  // The account the harness named, when it named one. A catalogue can differ per
  // account, so a surface showing one has to be able to say whose answer it is.
  account: ChatAccount | null;
};

export type ModelCatalog = {
  harnessId: string;
  state: CatalogState;
  // The last probe that answered, which outlives every failure after it. A
  // failed probe never clears this: stale-but-real beats fresh-but-empty.
  catalogue: Catalogue | null;
  // Set when the most recent attempt failed, cleared by one that answers.
  lastFailure: ProbeFailure | null;
};

/** The cached models for one harness, or none when it has never answered.
 *
 *  A harness in the `failed` state still has its models here when a previous
 *  probe succeeded, which is the whole reason the failure and the catalogue are
 *  separate fields. */
export function cachedModels(catalog: ModelCatalog | undefined): CatalogModel[] {
  return catalog?.catalogue?.models ?? [];
}
