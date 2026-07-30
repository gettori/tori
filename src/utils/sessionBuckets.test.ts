import { describe, it, expect } from "vitest";
import { bucketByLastActive } from "./sessionBuckets";

// A fixed local noon, so the day boundaries are unambiguous whatever timezone
// the suite runs in: everything below is expressed as an offset from it.
const NOON = Math.floor(new Date(2026, 6, 30, 12, 0, 0).getTime() / 1000);
const at = (secs: number) => ({ last_active: secs });
const HOUR = 3_600;
const DAY = 86_400;

const labels = (bs: { label: string }[]) => bs.map((b) => b.label);

describe("bucketByLastActive", () => {
  it("drops every bucket nothing fell into", () => {
    // The whole reason the panel can render headings at all: five fixed eras
    // would otherwise put four empty ones above the only session there is.
    expect(labels(bucketByLastActive([at(NOON - HOUR)], NOON))).toEqual(["Today"]);
    expect(bucketByLastActive([], NOON)).toEqual([]);
  });

  // Local midnight, not a rolling 24 hours: at 1am, last night at 11pm is
  // "Yesterday", which is what someone scanning the list means by it.
  it("cuts at local midnight rather than 24 hours back", () => {
    const oneAm = Math.floor(new Date(2026, 6, 30, 1, 0, 0).getTime() / 1000);
    const lastNight = Math.floor(new Date(2026, 6, 29, 23, 0, 0).getTime() / 1000);
    expect(labels(bucketByLastActive([at(lastNight)], oneAm))).toEqual(["Yesterday"]);
  });

  it("orders the eras newest first, and the sessions inside each one too", () => {
    const list = [
      at(NOON - 40 * DAY),
      at(NOON - 2 * HOUR),
      at(NOON - 3 * DAY),
      at(NOON - HOUR),
      at(NOON - DAY),
    ];
    const bs = bucketByLastActive(list, NOON);
    expect(labels(bs)).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
    expect(bs[0].sessions.map((s) => s.last_active)).toEqual([NOON - HOUR, NOON - 2 * HOUR]);
  });

  // Nothing may fall out of the list: it is the only place these sessions are
  // reachable now, so a session that lands in no bucket is a session gone.
  it("keeps every session exactly once, including one stamped in the future", () => {
    const list = [at(NOON + DAY), at(NOON), at(NOON - 8 * DAY), at(NOON - 31 * DAY), at(0)];
    const bs = bucketByLastActive(list, NOON);
    expect(bs.flatMap((b) => b.sessions)).toHaveLength(list.length);
    expect(labels(bs)).toEqual(["Today", "Previous 30 days", "Older"]);
  });
});
