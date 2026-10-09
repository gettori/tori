// One place for the catalog fields and the id rules, so the five pack kinds
// cannot drift apart on what a pack is.

pub mod index_rows;
pub mod publish;
pub mod snapshot;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

/// Who wrote a pack, credited on its card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contributor {
    pub name: String,
    pub github: String,
}

/// The catalog fields. Optional to load; the validator and the bundled-pack
/// tests are what require them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub contributor: Option<Contributor>,
    #[serde(default)]
    pub license: Option<String>,
}

/// An id is a file name and a folder name on every machine it reaches, so it
/// cannot carry a separator, a leading dot or anything a shell would expand.
pub fn check_id(id: &str, source: &str) -> Result<(), String> {
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = ID.get_or_init(|| regex::Regex::new(r"^[a-z0-9][a-z0-9._-]*$").unwrap());
    if pattern.is_match(id) {
        Ok(())
    } else {
        Err(format!(
            "{source}: id `{id}` must be lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit"
        ))
    }
}

/// The file a pack lives in is named after its id. `source` is a path, or
/// `bundled:<name>` for a built-in.
pub fn check_stem(source: &str, id: &str) -> Result<(), String> {
    let stem = match source.strip_prefix("bundled:") {
        Some(name) => name,
        None => Path::new(source)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default(),
    };
    if stem == id {
        Ok(())
    } else {
        Err(format!(
            "{source}: the file is named `{stem}` but its id is `{id}`; rename the file or change the id so they match"
        ))
    }
}

/// `check_stem` for a user file, reported rather than enforced: a file written
/// before the rule keeps loading until the packs migration renames it.
pub fn warn_stem(source: &str, id: &str) {
    if let Err(e) = check_stem(source, id) {
        eprintln!("tori: WARNING {e}");
    }
}

/// One exact version, `1.2.3` or `1.2.3-rc.1`. A range or a tag like `latest`
/// would install whatever the registry says today, which nobody has checked.
pub fn is_exact_version(version: &str) -> bool {
    static EXACT: OnceLock<regex::Regex> = OnceLock::new();
    EXACT
        .get_or_init(|| regex::Regex::new(r"^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$").unwrap())
        .is_match(version)
}

/// A calendar date written `YYYY-MM-DD`.
pub fn check_date(value: &str, field: &str, source: &str) -> Result<(), String> {
    let invalid = || format!("{source}: {field} `{value}` is not a date written YYYY-MM-DD");
    let parts: Vec<&str> = value.split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return Err(invalid());
    };
    if y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return Err(invalid());
    }
    let (Ok(year), Ok(month), Ok(day)) = (y.parse::<u32>(), m.parse::<u32>(), d.parse::<u32>()) else {
        return Err(invalid());
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(invalid()),
    };
    if (1..=days).contains(&day) {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// The catalog fields and `verified_on` as TOML, for each loader's tests to
/// prepend.
#[cfg(test)]
pub(crate) const TEST_CATALOG_TOML: &str = r#"description = "One line for the card"
license = "MIT"
contributor = { name = "Ada", github = "ada" }
verified_on = "2026-10-09"
"#;

#[cfg(test)]
pub(crate) fn test_meta() -> Meta {
    Meta {
        description: Some("One line for the card".into()),
        contributor: Some(Contributor {
            name: "Ada".into(),
            github: "ada".into(),
        }),
        license: Some("MIT".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_that_are_safe_file_names_pass() {
        for id in ["typescript", "vite-plus", "js-debug", "rose-pine.dawn", "c_cpp", "0x"] {
            assert!(check_id(id, "t").is_ok(), "{id}");
        }
    }

    #[test]
    fn ids_that_could_escape_or_surprise_are_refused() {
        for id in ["../x", "a/b", ".hidden", "-flag", "Upper", "", "with space", "a\\b"] {
            assert!(check_id(id, "t").is_err(), "{id}");
        }
    }

    #[test]
    fn a_stem_that_differs_from_the_id_names_both() {
        let err = check_stem("/x/packs/lsp/foo.toml", "bar").unwrap_err();
        assert!(err.contains("`foo`") && err.contains("`bar`"), "{err}");
        assert!(check_stem("/x/packs/lsp/bar.toml", "bar").is_ok());
        assert!(check_stem("bundled:bar", "bar").is_ok());
        assert!(check_stem("bundled:foo", "bar").is_err());
    }

    #[test]
    fn only_real_calendar_dates_pass() {
        for ok in ["2026-10-09", "2024-02-29", "2000-02-29"] {
            assert!(check_date(ok, "verified_on", "t").is_ok(), "{ok}");
        }
        for bad in [
            "2026-10-9",
            "2026/10/09",
            "2026-13-01",
            "2026-02-29",
            "1900-02-29",
            "2026-04-31",
            "26-10-09",
            "x",
        ] {
            assert!(check_date(bad, "verified_on", "t").is_err(), "{bad}");
        }
    }
}
