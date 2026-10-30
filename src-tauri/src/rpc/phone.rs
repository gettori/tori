//! The protocol range a phone and this daemon check each other against, so a
//! phone hears which side to update instead of failing calls.

use std::ops::RangeInclusive;

use serde::Serialize;

// Raised with `PROTOCOL` in mobile/src/remote.ts on a breaking change to what
// the app sends or reads. Builds from before the check send no number, so the
// protocol they already speak is 0.
pub const PHONE_PROTOCOL: u64 = 1;
// Raised only in a release whose notes tell phone users to update the app: a
// sideloaded APK never updates itself, so a floor raised with the release cuts
// off every phone nobody updated by hand.
pub const MIN_PHONE_PROTOCOL: u64 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    App,
    Tori,
}

pub fn update(protocol: Option<u64>, read: RangeInclusive<u64>) -> Option<Side> {
    match protocol.unwrap_or(0) {
        p if p < *read.start() => Some(Side::App),
        p if p > *read.end() => Some(Side::Tori),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_below_the_range_updates_the_app_and_above_it_tori() {
        assert_eq!(update(Some(1), 2..=3), Some(Side::App));
        assert_eq!(update(Some(2), 2..=3), None);
        assert_eq!(update(Some(3), 2..=3), None);
        assert_eq!(update(Some(4), 2..=3), Some(Side::Tori));
    }

    #[test]
    fn a_phone_that_sends_no_number_speaks_protocol_0() {
        assert_eq!(update(None, 1..=1), Some(Side::App));
        assert_eq!(update(None, 0..=1), None);
        assert_eq!(update(None, MIN_PHONE_PROTOCOL..=PHONE_PROTOCOL), None);
    }
}
