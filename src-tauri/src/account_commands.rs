//! A shell command per added account, so a terminal can run an agent as any
//! account Tori knows: `claude-work` runs `claude` with the Work profile home.
//!
//! **Scripts, not aliases.** An alias lives only in an interactive shell that
//! sourced it; a script on PATH works from bash, fish, a Makefile or another
//! tool, and needs no dotfile edit. They go in `~/.local/bin`, where claude's
//! own installer puts `claude`, so for anyone with claude installed that way
//! the directory is already on PATH.
//!
//! **Tori owns only what it marked.** Every script carries a marker naming the
//! build, the adapter and the profile, and the reconciler writes or deletes
//! only files carrying this build's marker. A user's own `claude-x` is never
//! touched, and a debug build (which keeps its own `accounts.json`) never
//! deletes the release build's scripts as stale.
//!
//! The default account has no script: it is the home variable left unset, so
//! its command is the agent's own binary.

use crate::accounts::{AccountsFile, Profile};
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

const MARKER: &str = "# tori-account ";

/// Which build wrote a script. Debug and release keep separate account stores
/// but share `~/.local/bin`.
pub fn build_tag() -> &'static str {
    if cfg!(debug_assertions) {
        "tori-dev"
    } else {
        "tori"
    }
}

/// Where the scripts go.
pub fn command_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".local/bin")
}

/// `<program>-<slug>`: lowercase, runs of anything but ASCII letters and digits
/// folded to one `-`, trimmed. A label with nothing left falls back to the
/// profile id, which is already a safe path segment.
pub fn command_slug(program: &str, label: &str, profile_id: &str) -> String {
    let mut slug = String::new();
    for c in label.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() {
        profile_id.replace('_', "-")
    } else {
        slug.to_string()
    };
    format!("{program}-{slug}")
}

/// A POSIX single-quoted word. The home is a path the user may have picked, so
/// a `'` inside it must close the quote, add an escaped one, and reopen.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn marker_line(build: &str, adapter_id: &str, profile_id: &str) -> String {
    format!("{MARKER}{build}/{adapter_id}/{profile_id}")
}

/// The whole script for one account.
pub fn script_text(build: &str, adapter_id: &str, profile_id: &str, var: &str, home: &str, program: &str) -> String {
    format!(
        "#!/bin/sh\n{}\nexport {var}={}\nexec {program} \"$@\"\n",
        marker_line(build, adapter_id, profile_id),
        sh_quote(home),
    )
}

/// The build that marked this file, or `None` for a file Tori did not write.
/// Reads the head only: `~/.local/bin` also holds the agent binaries, and
/// `claude` alone is hundreds of megabytes.
fn marked_by(path: &Path) -> Option<String> {
    let mut head = [0u8; 512];
    let n = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head[..n]);
    let line = text.lines().nth(1)?;
    let rest = line.strip_prefix(MARKER)?;
    Some(rest.split('/').next()?.to_string())
}

/// One script the store says should exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    pub name: String,
    pub text: String,
}

/// Whether `name` in `dir` is held by a file this build did not write.
pub fn foreign(dir: &Path, name: &str, build: &str) -> bool {
    let path = dir.join(name);
    path.exists() && marked_by(&path).as_deref() != Some(build)
}

/// Every command already claimed by a stored profile, across adapters, since
/// they all share one directory.
fn claimed(file: &AccountsFile) -> BTreeSet<String> {
    file.adapters
        .values()
        .flatten()
        .filter_map(|p| p.command.clone())
        .collect()
}

/// The command a profile without one gets: its slug, or the first free `-2`,
/// `-3` when another profile or a foreign file holds it.
fn free_name(base: &str, taken: &BTreeSet<String>, is_foreign: &dyn Fn(&str) -> bool) -> String {
    let free = |name: &str| !taken.contains(name) && !is_foreign(name);
    if free(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|name| free(name))
        .expect("an unbounded range always finds a free suffix")
}

/// Give every added profile of an adapter with a home variable a command, where
/// it has none: profiles stored before the field existed, and one just added.
/// Answers whether anything changed, so the caller saves only then.
pub fn assign_commands(
    file: &mut AccountsFile,
    program_of: &dyn Fn(&str) -> Option<String>,
    is_foreign: &dyn Fn(&str) -> bool,
) -> bool {
    let mut taken = claimed(file);
    let mut changed = false;
    for (adapter_id, profiles) in file.adapters.iter_mut() {
        let Some(program) = program_of(adapter_id) else {
            continue;
        };
        for profile in profiles.iter_mut().filter(|p| p.command.is_none()) {
            let name = free_name(&command_slug(&program, &profile.label, &profile.id), &taken, is_foreign);
            taken.insert(name.clone());
            profile.command = Some(name);
            changed = true;
        }
    }
    changed
}

/// Move a profile's command to the slug of `label`, or say why not. A taken
/// name refuses rather than suffixes: the user asked for that name.
pub fn retarget_command(
    file: &mut AccountsFile,
    adapter_id: &str,
    profile_id: &str,
    program: &str,
    label: &str,
    is_foreign: &dyn Fn(&str) -> bool,
) -> Result<(), String> {
    let name = command_slug(program, label.trim(), profile_id);
    let mut taken = claimed(file);
    let profile = file
        .adapters
        .get_mut(adapter_id)
        .and_then(|added| added.iter_mut().find(|p| p.id == profile_id))
        .ok_or_else(|| format!("no profile `{profile_id}` for `{adapter_id}`"))?;
    if profile.command.as_deref() == Some(name.as_str()) {
        return Ok(());
    }
    if let Some(own) = &profile.command {
        taken.remove(own);
    }
    if taken.contains(&name) {
        return Err(format!("`{name}` is already another account's command."));
    }
    if is_foreign(&name) {
        return Err(format!(
            "`{name}` is already a file Tori did not write, so pick another name."
        ));
    }
    profile.command = Some(name);
    Ok(())
}

/// The scripts `file` describes, for adapters with a home variable.
pub fn wanted(file: &AccountsFile, build: &str, env_of: &dyn Fn(&str) -> Option<(String, String)>) -> Vec<Wanted> {
    let mut out = Vec::new();
    for (adapter_id, profiles) in &file.adapters {
        let Some((var, program)) = env_of(adapter_id) else {
            continue;
        };
        for profile in profiles {
            if let (Some(name), Some(home)) = (&profile.command, &profile.home) {
                out.push(Wanted {
                    name: name.clone(),
                    text: script_text(build, adapter_id, &profile.id, &var, home, &program),
                });
            }
        }
    }
    out
}

/// Make `dir` hold exactly this build's `wanted` scripts, leaving every other
/// file alone.
pub fn sync_in(dir: &Path, build: &str, wanted: &[Wanted]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let names: BTreeSet<&str> = wanted.iter().map(|w| w.name.as_str()).collect();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !names.contains(name.as_str()) && marked_by(&path).as_deref() == Some(build) {
            std::fs::remove_file(&path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
        }
    }
    for w in wanted {
        let path = dir.join(&w.name);
        if foreign(dir, &w.name, build) {
            continue;
        }
        if std::fs::read_to_string(&path).ok().as_deref() != Some(w.text.as_str()) {
            std::fs::write(&path, &w.text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("cannot make {} executable: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn program_of(adapter_id: &str) -> Option<String> {
    env_of(adapter_id).map(|(_, program)| program)
}

fn env_of(adapter_id: &str) -> Option<(String, String)> {
    let adapter = crate::agents::find(adapter_id)?;
    let var = adapter.accounts.as_ref()?.home_env.clone()?;
    Some((var, adapter.program.clone()))
}

/// The command an account runs as, for the card: the agent's own binary for the
/// default account, the stored one for an added account while this build's
/// script is really there. `None` where the adapter has no home variable, so no
/// command could select the account.
pub fn command_for(adapter: &crate::agents::AgentAdapter, profile: &Profile, dir: &Path) -> Option<String> {
    adapter.accounts.as_ref()?.home_env.as_ref()?;
    if profile.is_default() {
        return Some(adapter.program.clone());
    }
    let name = profile.command.as_ref()?;
    (marked_by(&dir.join(name)).as_deref() == Some(build_tag())).then(|| name.clone())
}

/// Whether `dir` is on the login shell's PATH. Unknown (no captured PATH) reads
/// as on, so the card does not nag on a guess.
pub fn on_path(dir: &Path, path_var: Option<&str>) -> bool {
    let Some(path_var) = path_var else {
        return true;
    };
    let want = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    std::env::split_paths(path_var).any(|entry| std::fs::canonicalize(&entry).unwrap_or(entry) == want)
}

/// Load the store, give new profiles their command, and bring the directory in
/// line. Run at launch and after every add, remove and rename.
pub fn sync() -> Result<(), String> {
    let _held = crate::accounts::lock_store();
    let dir = command_dir();
    let build = build_tag();
    let mut file = crate::accounts::load();
    if assign_commands(&mut file, &program_of, &|name| foreign(&dir, name, build)) {
        crate::accounts::save(&file)?;
    }
    sync_in(&dir, build, &wanted(&file, build, &env_of))
}

/// [`sync`] for a caller that has already done its own job: a script that could
/// not be written is not a reason to fail the account change around it.
pub fn sync_quietly() {
    if let Err(e) = sync() {
        eprintln!("tori: account commands: {e}");
    }
}

/// Rename with the command following, under the store lock.
pub fn rename_with_command(adapter_id: &str, profile_id: &str, label: &str) -> Result<(), String> {
    let _held = crate::accounts::lock_store();
    let (_, program) = env_of(adapter_id).ok_or_else(|| format!("`{adapter_id}` has no account commands"))?;
    let dir = command_dir();
    let build = build_tag();
    let mut file = crate::accounts::load();
    retarget_command(&mut file, adapter_id, profile_id, &program, label, &|name| {
        foreign(&dir, name, build)
    })?;
    crate::accounts::rename_profile(&mut file, adapter_id, profile_id, label)?;
    crate::accounts::save(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added(id: &str, label: &str, home: &str) -> Profile {
        Profile {
            id: id.to_string(),
            label: label.to_string(),
            email: None,
            home: Some(home.to_string()),
            managed: true,
            command: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tori-cmd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn claude(_: &str) -> Option<String> {
        Some("claude".into())
    }

    fn nothing_foreign(_: &str) -> bool {
        false
    }

    #[test]
    fn a_label_becomes_a_lowercase_dashed_command() {
        assert_eq!(command_slug("claude", "Work", "work"), "claude-work");
        assert_eq!(command_slug("claude", "Tori Dev!", "tori_dev"), "claude-tori-dev");
        assert_eq!(command_slug("claude", "  a -- b  ", "a"), "claude-a-b");
    }

    #[test]
    fn a_label_with_nothing_usable_falls_back_to_the_profile_id() {
        assert_eq!(
            command_slug("claude", "\u{1F680}\u{2728}", "account_2"),
            "claude-account-2"
        );
    }

    #[test]
    fn the_default_account_runs_as_the_agents_own_binary() {
        let adapter = crate::agents::find("claude").unwrap();
        let mut default = crate::accounts::default_profile();
        default.label = "Personal".into();
        assert_eq!(
            command_for(&adapter, &default, Path::new("/nowhere")).as_deref(),
            Some("claude")
        );
    }

    #[test]
    fn adding_the_same_name_twice_suffixes_the_second() {
        let mut file = AccountsFile::default();
        file.adapters.insert(
            "claude".into(),
            vec![added("work", "Work", "/h/work"), added("work-2", "Work", "/h/work-2")],
        );
        assert!(assign_commands(&mut file, &claude, &nothing_foreign));
        let names: Vec<_> = file.adapters["claude"]
            .iter()
            .map(|p| p.command.clone().unwrap())
            .collect();
        assert_eq!(names, ["claude-work", "claude-work-2"]);
        assert!(!assign_commands(&mut file, &claude, &nothing_foreign));
    }

    #[test]
    fn a_foreign_file_pushes_a_new_command_past_its_name() {
        let mut file = AccountsFile::default();
        file.adapters
            .insert("claude".into(), vec![added("work", "Work", "/h/work")]);
        assign_commands(&mut file, &claude, &|name| name == "claude-work");
        assert_eq!(file.adapters["claude"][0].command.as_deref(), Some("claude-work-2"));
    }

    #[test]
    fn an_adapter_without_a_home_variable_gets_no_command() {
        let mut file = AccountsFile::default();
        file.adapters.insert("opencode".into(), vec![added("x", "X", "/h/x")]);
        assert!(!assign_commands(&mut file, &|_| None, &nothing_foreign));
        assert_eq!(file.adapters["opencode"][0].command, None);
    }

    #[test]
    fn renaming_with_the_command_moves_it_and_refuses_a_taken_name() {
        let mut file = AccountsFile::default();
        let mut work = added("work", "Work", "/h/work");
        work.command = Some("claude-work".into());
        let mut home = added("home", "Home", "/h/home");
        home.command = Some("claude-home".into());
        file.adapters.insert("claude".into(), vec![work, home]);

        retarget_command(&mut file, "claude", "work", "claude", "Job", &nothing_foreign).unwrap();
        assert_eq!(file.adapters["claude"][0].command.as_deref(), Some("claude-job"));

        let err = retarget_command(&mut file, "claude", "work", "claude", "Home", &nothing_foreign).unwrap_err();
        assert!(err.contains("claude-home"), "{err}");
        let err = retarget_command(&mut file, "claude", "work", "claude", "Mine", &|n| n == "claude-mine").unwrap_err();
        assert!(err.contains("did not write"), "{err}");
        assert_eq!(file.adapters["claude"][0].command.as_deref(), Some("claude-job"));
    }

    #[test]
    fn renaming_to_the_same_slug_is_not_a_collision_with_itself() {
        let mut file = AccountsFile::default();
        let mut work = added("work", "Work", "/h/work");
        work.command = Some("claude-work".into());
        file.adapters.insert("claude".into(), vec![work]);
        retarget_command(&mut file, "claude", "work", "claude", "WORK", &|_| true).unwrap();
    }

    #[test]
    fn the_card_names_a_command_only_while_this_builds_script_is_there() {
        let dir = scratch("card");
        let adapter = crate::agents::find("claude").unwrap();
        let mut work = added("work", "Work", "/h/work");
        work.command = Some("claude-work".into());
        assert_eq!(command_for(&adapter, &work, &dir), None);
        std::fs::write(dir.join("claude-work"), "#!/bin/sh\necho mine\n").unwrap();
        assert_eq!(command_for(&adapter, &work, &dir), None);
        let ours = script_text(build_tag(), "claude", "work", "V", "/h/work", "claude");
        std::fs::write(dir.join("claude-work"), ours).unwrap();
        assert_eq!(command_for(&adapter, &work, &dir).as_deref(), Some("claude-work"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sync_writes_removes_its_own_and_leaves_everything_else() {
        let dir = scratch("sync");
        std::fs::write(dir.join("claude-work"), "#!/bin/sh\necho mine\n").unwrap();
        std::fs::write(
            dir.join("claude-old"),
            script_text("tori", "claude", "old", "V", "/h/old", "claude"),
        )
        .unwrap();
        std::fs::write(
            dir.join("claude-rel"),
            script_text("tori", "claude", "rel", "V", "/h/rel", "claude"),
        )
        .unwrap();

        assert!(foreign(&dir, "claude-work", "tori"));
        let wanted = vec![Wanted {
            name: "claude-job".into(),
            text: script_text("tori-dev", "claude", "job", "V", "/h/job", "claude"),
        }];
        sync_in(&dir, "tori-dev", &wanted).unwrap();
        assert!(dir.join("claude-old").exists(), "another build's script must survive");
        assert!(dir.join("claude-job").exists());

        sync_in(&dir, "tori", &[]).unwrap();
        assert!(!dir.join("claude-old").exists());
        assert!(!dir.join("claude-rel").exists());
        assert!(dir.join("claude-job").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("claude-work")).unwrap(),
            "#!/bin/sh\necho mine\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_home_with_a_space_and_a_quote_reaches_the_agent_byte_identical() {
        let dir = scratch("exec");
        let shim = dir.join("claude");
        std::fs::write(&shim, "#!/bin/sh\nprintf '%s' \"$CLAUDE_CONFIG_DIR\"\n").unwrap();
        let home = "/Users/x/Application Support/Arif's claude";
        let wanted = vec![Wanted {
            name: "claude-work".into(),
            text: script_text("tori", "claude", "work", "CLAUDE_CONFIG_DIR", home, "claude"),
        }];
        sync_in(&dir, "tori", &wanted).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let out = std::process::Command::new(dir.join("claude-work"))
            .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
            .env_remove("CLAUDE_CONFIG_DIR")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), home);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_trailing_slash_on_the_path_entry_still_counts_as_on_path() {
        let dir = scratch("path");
        let entry = format!("/usr/bin:{}/", dir.display());
        assert!(on_path(&dir, Some(&entry)));
        assert!(!on_path(&dir, Some("/usr/bin:/bin")));
        assert!(on_path(&dir, None));
        std::fs::remove_dir_all(&dir).ok();
    }
}
