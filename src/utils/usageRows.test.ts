import { describe, it, expect } from "vite-plus/test";
import { usageSummary } from "./usageRows";
import type { WindowReading } from "./usageStore";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const reading = (kind: string, utilization: number | null, resetsInMs: number): WindowReading => ({
  kind,
  utilization,
  resetsAt: (NOW + resetsInMs) / 1000,
  status: null,
  reachedType: null,
  sampledAt: NOW,
  source: "sessions",
});

describe("usageSummary", () => {
  it("names each window's level and when the fullest one resets", () => {
    const windows = [reading("five_hour", 0.42, 130 * MIN), reading("seven_day", 0.18, 4 * 24 * 60 * MIN)];
    expect(usageSummary({ windows, warnAt: 0.8 }, NOW)).toEqual({
      sub: "5 Hour 42%, Week 18%, resets in 2h 10m",
      level: 0.42,
      warn: false,
    });
  });

  it("warns past the account's Warn at, on the window nearest its limit", () => {
    const windows = [reading("five_hour", 0.3, 38 * MIN), reading("seven_day", 0.91, 3 * 24 * 60 * MIN + 5 * 60 * MIN)];
    expect(usageSummary({ windows, warnAt: 0.8 }, NOW)).toEqual({
      sub: "5 Hour 30%, Week 91%, resets in 3d 5h",
      level: 0.91,
      warn: true,
    });
  });

  it("reads a window past its reset as 0% and a level nobody sent as ?, warning on neither", () => {
    const windows = [reading("five_hour", 0.98, -MIN), reading("seven_day", null, 60 * MIN)];
    expect(usageSummary({ windows, warnAt: 0.8 }, NOW)).toEqual({
      sub: "5 Hour 0%, Week ?, resets in 1h 0m",
      level: 0,
      warn: false,
    });
  });
});
