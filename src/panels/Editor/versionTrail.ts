// A server lints version N while the editor has already sent N+1. Its publish
// for N is carried through the changes since, rather than dropped (the file goes
// bare until it catches up) or applied as is (squiggles land on the wrong text).

import { ChangeSet, type ChangeDesc, type Text } from "@codemirror/state";

// A server this far behind is about to publish again anyway.
const KEPT = 16;

export class VersionTrail {
  private entries: { version: number; doc: Text; next: ChangeSet | null }[] = [];

  /** `changes` takes the previous version onto `doc`; null starts a new trail. */
  record(version: number, doc: Text, changes: ChangeSet | null): void {
    const last = this.entries[this.entries.length - 1];
    if (!changes || !last) this.entries = [];
    else last.next = changes;
    this.entries.push({ version, doc, next: null });
    if (this.entries.length > KEPT) this.entries.shift();
  }

  /** The text sent as `version` (the latest when none is named) and the changes
   *  from it to the latest, or null when that version is not held. */
  since(version: number | null | undefined): { doc: Text; changes: ChangeDesc } | null {
    const at = version == null ? this.entries.length - 1 : this.entries.findIndex((e) => e.version === version);
    if (at < 0) return null;
    const { doc } = this.entries[at];
    let changes: ChangeDesc = ChangeSet.empty(doc.length).desc;
    for (let i = at; i < this.entries.length - 1; i++) changes = changes.composeDesc(this.entries[i].next!.desc);
    return { doc, changes };
  }
}
