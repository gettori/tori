---
summary: a clock asleep until the soonest slot fired a just-added schedule 53 s late; writes must wake it
status: current
updated: 2026-10-21
source: gettori/tickets#43 on branch scheduled-runs, plan "Scheduled runs"; commits 0cdcf86b, ee900c1d, f5e7ccb4; src-tauri/src/autopilot.rs (clock_wake, wake_clock, wait_for_schedules); src-tauri/src/rpc/office.rs (start_clock)
---

# A clock asleep until the next slot misses a slot added just before

The schedule clock computes its sleep from the schedules it knew at the last pass. A schedule added at 17:08:54 for 17:09 fired at 17:09:53, because the clock had gone to sleep for a full minute before the add. The same shape hid a pause: a third failure in mid-day would be announced only at the next slot, maybe a day later. Fix: the store sets `clock_wake` (a `Mutex<bool>` plus `Condvar`) whenever a schedule is written or a scheduled run closes, and the clock waits on it with `wait_timeout_while` instead of `thread::sleep`. Do not swap it back for a plain sleep.

## Related

- [[component_autopilot_schedules]]: the clock
