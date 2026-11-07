//! A project's named branch groups, `[[project_meta.group]]` in `tori.toml`.
//!
//! Membership changes only when the user says so: discovery never prunes, so a
//! project whose folder cannot be read today keeps its groups for tomorrow.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use toml_edit::{value, Array, ArrayOfTables, Document, Item, Table};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchGroup {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
    #[serde(default)]
    pub branches: Vec<String>,
}

pub fn normalized(raw: &[BranchGroup]) -> Vec<BranchGroup> {
    let mut names = std::collections::HashSet::new();
    let mut taken = std::collections::HashSet::new();
    raw.iter()
        .filter_map(|g| {
            let name = g.name.trim();
            if name.is_empty() || !names.insert(name.to_string()) {
                return None;
            }
            let branches: Vec<String> = g
                .branches
                .iter()
                .filter(|b| !b.is_empty() && taken.insert(b.to_string()))
                .cloned()
                .collect();
            (!branches.is_empty()).then(|| BranchGroup {
                name: name.to_string(),
                colour: g.colour.clone().filter(|c| !c.is_empty()),
                branches,
            })
        })
        .collect()
}

// A hand-edited entry may spell its path with `~`.
fn same_path(stored: &str, path: &str) -> bool {
    stored == path || super::expand_tilde(stored) == path
}

fn meta_table<'a>(doc: &'a mut Document, path: &str) -> Result<&'a mut Table, String> {
    if doc.get("project_meta").is_none() {
        doc["project_meta"] = Item::ArrayOfTables(ArrayOfTables::new());
    }
    let tables = doc["project_meta"]
        .as_array_of_tables_mut()
        .ok_or("`project_meta` is not an array of tables")?;
    let pos = tables.iter().position(|t| {
        t.get("path")
            .and_then(|v| v.as_str())
            .is_some_and(|p| same_path(p, path))
    });
    let i = match pos {
        Some(i) => i,
        None => {
            let mut t = Table::new();
            t["path"] = value(path);
            tables.push(t);
            tables.len() - 1
        }
    };
    Ok(tables.get_mut(i).expect("index from position or push"))
}

pub(super) fn prune_bare_meta(doc: &mut Document) {
    if let Some(tables) = doc.get_mut("project_meta").and_then(|i| i.as_array_of_tables_mut()) {
        tables.retain(|t| t.iter().any(|(k, _)| k != "path"));
        if tables.is_empty() {
            doc.remove("project_meta");
        }
    }
}

pub(super) fn upsert_groups(text: &str, path: &str, groups: &[BranchGroup]) -> Result<String, String> {
    let mut doc: Document = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let t = meta_table(&mut doc, path)?;
    let groups = normalized(groups);
    if groups.is_empty() {
        t.remove("group");
    } else {
        let mut out = ArrayOfTables::new();
        for g in &groups {
            let mut gt = Table::new();
            gt["name"] = value(g.name.as_str());
            if let Some(c) = &g.colour {
                gt["colour"] = value(c.as_str());
            }
            gt["branches"] = value(g.branches.iter().map(String::as_str).collect::<Array>());
            out.push(gt);
        }
        t["group"] = Item::ArrayOfTables(out);
    }
    prune_bare_meta(&mut doc);
    Ok(doc.to_string())
}

fn groups_in(text: &str, path: &str) -> Vec<BranchGroup> {
    #[derive(Deserialize, Default)]
    struct Raw {
        #[serde(default)]
        project_meta: Vec<Meta>,
    }
    #[derive(Deserialize)]
    struct Meta {
        path: String,
        #[serde(default)]
        group: Vec<BranchGroup>,
    }
    toml::from_str::<Raw>(text)
        .unwrap_or_default()
        .project_meta
        .into_iter()
        .find(|m| same_path(&m.path, path))
        .map(|m| m.group)
        .unwrap_or_default()
}

pub(super) fn without_branch(text: &str, path: &str, branch: &str) -> Result<Option<String>, String> {
    let mut groups = groups_in(text, path);
    let before = groups.clone();
    for g in &mut groups {
        g.branches.retain(|b| b != branch);
    }
    groups.retain(|g| !g.branches.is_empty());
    if groups == before {
        return Ok(None);
    }
    upsert_groups(text, path, &groups).map(Some)
}

#[tauri::command(async)]
pub fn set_project_groups(app: AppHandle, path: String, groups: Vec<BranchGroup>) -> Result<(), String> {
    {
        let _store = crate::exec::cross_process_store_lock("config")?;
        let text = super::ensure_config()?;
        let next = upsert_groups(&text, &path, &groups)?;
        if next == text {
            return Ok(());
        }
        super::write_config(&next)?;
    }
    let _ = app.emit("config://changed", ());
    Ok(())
}

/// The caller emits `config://changed`, as every removal already does.
pub fn forget_branch(project: &str, branch: &str) {
    if touches_a_group(project, branch) {
        let done = crate::exec::cross_process_store_lock("config").and_then(|held| drop_member(&held, project, branch));
        report(done, project, branch);
    }
}

pub(super) fn forget_branch_locked(held: &crate::exec::StoreLock, project: &str, branch: &str) {
    if touches_a_group(project, branch) {
        report(drop_member(held, project, branch), project, branch);
    }
}

// Read without the lock: almost every removal touches no group, and those must
// not take the lock or write at all.
fn touches_a_group(project: &str, branch: &str) -> bool {
    std::fs::read_to_string(super::config_path())
        .is_ok_and(|text| matches!(without_branch(&text, project, branch), Ok(Some(_))))
}

fn drop_member(_held: &crate::exec::StoreLock, project: &str, branch: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(super::config_path()).map_err(|e| e.to_string())?;
    match without_branch(&text, project, branch)? {
        Some(next) => super::write_config(&next),
        None => Ok(()),
    }
}

fn report(done: Result<(), String>, project: &str, branch: &str) {
    if let Err(e) = done {
        eprintln!("[tori] could not drop {branch} from its group in {project}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(name: &str, colour: Option<&str>, branches: &[&str]) -> BranchGroup {
        BranchGroup {
            name: name.into(),
            colour: colour.map(Into::into),
            branches: branches.iter().map(|b| b.to_string()).collect(),
        }
    }

    #[test]
    fn groups_write_as_tables_under_their_project() {
        let start = "[discovery]\nroots = [\"~/Tori\"]\n\n[[project_meta]]\npath = \"/p/tori\"\nicon = \"Rocket\"\n";
        let out = upsert_groups(
            start,
            "/p/tori",
            &[
                group("Drag and drop", Some("blue"), &["dnd-core", "dnd-ghost"]),
                group("Billing", None, &["invoices"]),
            ],
        )
        .unwrap();
        assert_eq!(
            out,
            "[discovery]\nroots = [\"~/Tori\"]\n\n[[project_meta]]\npath = \"/p/tori\"\nicon = \"Rocket\"\n\n\
             [[project_meta.group]]\nname = \"Drag and drop\"\ncolour = \"blue\"\nbranches = [\"dnd-core\", \"dnd-ghost\"]\n\n\
             [[project_meta.group]]\nname = \"Billing\"\nbranches = [\"invoices\"]\n"
        );
    }

    #[test]
    fn a_branch_named_twice_stays_in_its_first_group() {
        let raw = [
            group("A", None, &["x", "y"]),
            group("B", None, &["y", "z"]),
            group("A", None, &["w"]),
        ];
        assert_eq!(
            normalized(&raw),
            vec![group("A", None, &["x", "y"]), group("B", None, &["z"])]
        );
    }

    #[test]
    fn other_projects_entries_are_left_alone() {
        let start = "[[project_meta]]\npath = \"/p/other\"\nicon = \"Star\"\n";
        let out = upsert_groups(start, "/p/tori", &[group("G", None, &["a"])]).unwrap();
        assert!(out.starts_with(start));
        let back = upsert_groups(&out, "/p/tori", &[]).unwrap();
        assert_eq!(back, start, "an entry emptied of its groups goes, the other stays");
    }

    #[test]
    fn a_tilde_path_is_the_same_entry() {
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        let start = "[[project_meta]]\npath = \"~/p/tori\"\n\n[[project_meta.group]]\nname = \"G\"\nbranches = [\"a\", \"b\"]\n";
        let out = without_branch(start, &format!("{home}/p/tori"), "a").unwrap().unwrap();
        assert_eq!(out.matches("[[project_meta]]").count(), 1);
        assert!(out.contains("branches = [\"b\"]"));
    }

    #[test]
    fn removing_the_last_member_deletes_the_group() {
        let start = upsert_groups(
            "",
            "/p/tori",
            &[group("G", None, &["a"]), group("H", None, &["b", "c"])],
        )
        .unwrap();
        let out = without_branch(&start, "/p/tori", "a").unwrap().unwrap();
        assert_eq!(groups_in(&out, "/p/tori"), vec![group("H", None, &["b", "c"])]);
        assert_eq!(without_branch(&out, "/p/tori", "nobody").unwrap(), None);
    }
}
