//! A schedule lives beside the queue, not in it: it never ends, so every
//! queue reader would have to learn to skip it.

use chrono::{DateTime, TimeZone, Utc};
use croner::parser::{CronParser, Seconds, Year};
use croner::Cron;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum What {
    /// What each run does, in words.
    Prompt { text: String },
    /// The issue each run works on, by its canonical key.
    Issue { key: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub project: String,
    pub cron: String,
    pub what: What,
    pub created: u64,
    #[serde(default)]
    pub last_slot: Option<u64>,
    #[serde(default)]
    pub resumed_at: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Schedules {
    #[serde(default)]
    pub schedules: Vec<Schedule>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScheduleRow {
    #[serde(flatten)]
    pub schedule: Schedule,
    pub next_run: Option<u64>,
}

pub fn parse(cron: &str) -> Result<Cron, String> {
    CronParser::builder()
        .seconds(Seconds::Disallowed)
        .year(Year::Disallowed)
        .build()
        .parse(cron)
        .map_err(|e| format!("{cron:?} is not a five-field cron: {e}"))
}

fn at<Tz: TimeZone>(ms: u64, tz: &Tz) -> Option<DateTime<Tz>> {
    let utc = DateTime::<Utc>::from_timestamp_millis(i64::try_from(ms).ok()?)?;
    Some(utc.with_timezone(tz))
}

fn ms<Tz: TimeZone>(time: &DateTime<Tz>) -> Option<u64> {
    u64::try_from(time.timestamp_millis()).ok()
}

pub fn next_after<Tz: TimeZone>(cron: &Cron, after: u64, tz: &Tz) -> Option<u64> {
    ms(&cron.find_next_occurrence(&at(after, tz)?, false).ok()?)
}

// The latest slot only, so a Mac that slept through several fires once.
pub fn due<Tz: TimeZone>(schedule: &Schedule, now: u64, tz: &Tz) -> Option<u64> {
    let cron = parse(&schedule.cron).ok()?;
    let from = schedule.last_slot.unwrap_or(schedule.created);
    let first = next_after(&cron, from, tz)?;
    if first > now {
        return None;
    }
    let latest = ms(&cron.find_previous_occurrence(&at(now, tz)?, true).ok()?)?;
    Some(latest.max(first))
}

pub fn row<Tz: TimeZone>(schedule: &Schedule, now: u64, tz: &Tz) -> ScheduleRow {
    ScheduleRow {
        schedule: schedule.clone(),
        next_run: next_run(schedule, now, tz),
    }
}

pub fn next_run<Tz: TimeZone>(schedule: &Schedule, now: u64, tz: &Tz) -> Option<u64> {
    let cron = parse(&schedule.cron).ok()?;
    let from = schedule.last_slot.unwrap_or(schedule.created).max(now);
    next_after(&cron, from, tz)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime};

    #[derive(Debug, Clone, Copy)]
    struct Oslo;

    fn summer(utc: &NaiveDateTime) -> bool {
        let on = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(1, 0, 0).unwrap();
        let off = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap().and_hms_opt(1, 0, 0).unwrap();
        (on..off).contains(utc)
    }

    fn hours(h: i32) -> FixedOffset {
        FixedOffset::east_opt(h * 3600).unwrap()
    }

    impl TimeZone for Oslo {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            Oslo
        }
        fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<FixedOffset> {
            let fits = |h: i32| self.offset_from_utc_datetime(&(*local - chrono::Duration::hours(h.into()))) == hours(h);
            match (fits(2), fits(1)) {
                (true, true) => LocalResult::Ambiguous(hours(2), hours(1)),
                (true, false) => LocalResult::Single(hours(2)),
                (false, true) => LocalResult::Single(hours(1)),
                (false, false) => LocalResult::None,
            }
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            if summer(utc) {
                hours(2)
            } else {
                hours(1)
            }
        }
    }

    fn utc(day: u32, h: u32, m: u32, s: u32) -> u64 {
        let t = NaiveDate::from_ymd_opt(2026, 10, day).unwrap().and_hms_opt(h, m, s).unwrap();
        t.and_utc().timestamp_millis() as u64
    }

    fn schedule(cron: &str, created: u64, last_slot: Option<u64>) -> Schedule {
        Schedule {
            id: "sched-1".into(),
            name: "bump".into(),
            project: "/p".into(),
            cron: cron.into(),
            what: What::Prompt { text: "bump deps".into() },
            created,
            last_slot,
            resumed_at: None,
        }
    }

    #[test]
    fn a_five_field_cron_parses_and_seconds_or_years_do_not() {
        assert!(parse("0 7 * * 1-5").is_ok());
        assert!(parse("@daily").is_ok());
        assert!(parse("0 0 7 * * 1-5").is_err());
        assert!(parse("0 7 * * 1-5 2027").is_err());
        assert!(parse("every morning").is_err());
    }

    #[test]
    fn it_fires_on_time_and_once() {
        let s = schedule("0 7 * * 1-5", utc(19, 6, 0, 0), None);
        assert_eq!(due(&s, utc(19, 6, 59, 59), &Utc), None);
        assert_eq!(due(&s, utc(19, 7, 0, 0), &Utc), Some(utc(19, 7, 0, 0)));
        assert_eq!(due(&s, utc(19, 7, 0, 40), &Utc), Some(utc(19, 7, 0, 0)));
        let fired = schedule("0 7 * * 1-5", utc(19, 6, 0, 0), Some(utc(19, 7, 0, 0)));
        assert_eq!(due(&fired, utc(19, 7, 0, 40), &Utc), None);
        assert_eq!(due(&fired, utc(19, 23, 0, 0), &Utc), None);
    }

    #[test]
    fn missed_slots_fire_once_for_the_latest() {
        let s = schedule("0 7 * * 1-5", utc(1, 0, 0, 0), Some(utc(19, 7, 0, 0)));
        assert_eq!(due(&s, utc(22, 9, 0, 0), &Utc), Some(utc(22, 7, 0, 0)));
        let s = schedule("0 7 * * 1-5", utc(1, 0, 0, 0), Some(utc(22, 7, 0, 0)));
        assert_eq!(due(&s, utc(25, 12, 0, 0), &Utc), Some(utc(23, 7, 0, 0)));
    }

    #[test]
    fn a_new_schedule_never_fires_for_a_slot_before_it_existed() {
        let s = schedule("0 7 * * *", utc(19, 8, 0, 0), None);
        assert_eq!(due(&s, utc(19, 8, 5, 0), &Utc), None);
        assert_eq!(next_run(&s, utc(19, 8, 5, 0), &Utc), Some(utc(20, 7, 0, 0)));
    }

    #[test]
    fn a_repeated_hour_fires_once() {
        let s = schedule("30 2 * * *", utc(1, 0, 0, 0), Some(utc(25, 0, 30, 0)));
        assert_eq!(due(&s, utc(25, 1, 45, 0), &Oslo), None);
        assert_eq!(due(&s, utc(26, 1, 31, 0), &Oslo), Some(utc(26, 1, 30, 0)));
    }

    #[test]
    fn a_skipped_hour_fires_at_most_once() {
        let march = |day: u32, h: u32, m: u32| {
            let t = NaiveDate::from_ymd_opt(2026, 3, day).unwrap().and_hms_opt(h, m, 0).unwrap();
            t.and_utc().timestamp_millis() as u64
        };
        let s = schedule("30 2 * * *", march(1, 0, 0), Some(march(28, 1, 30)));
        let slot = due(&s, march(29, 11, 0), &Oslo);
        assert!(slot.is_none_or(|slot| slot > march(28, 1, 30) && slot <= march(29, 11, 0)));
        let after = schedule("30 2 * * *", march(1, 0, 0), slot.or(Some(march(28, 1, 30))));
        assert_eq!(due(&after, march(29, 11, 0), &Oslo), None);
    }
}
