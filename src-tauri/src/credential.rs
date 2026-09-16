// Tori's git credential helper: git asks for a login, Tori answers with the
// account that repo is signed in as.
//
// The askpass bridge cannot do this job. It is git's *last* resort: it runs
// after every configured `credential.helper`, so an osxkeychain entry for the
// host wins over the account the user picked, and whatever askpass answers is
// then stored by that same helper. A helper of Tori's own runs first, and this
// one stores nothing.
//
// The hard part is that git hands a helper only protocol, host and (with
// `useHttpPath`) path. Never the checkout. Two accounts on one host are
// indistinguishable from there, which is the whole feature. So the op carries
// the account: `bridge` registers the op's root under its id, and the helper
// sends that id back. The registration lives exactly as long as the git child.
//
// It runs as this same binary re-exec'd, like `askpass`, and speaks over the
// askpass socket with the same per-session token: one door, authenticated once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

/// argv marker, from `credential.helper = !'<exe>' --credential`.
pub const ARG: &str = "--credential";

/// Which checkout each in-flight bridged op belongs to.
fn ops() -> &'static Mutex<HashMap<String, String>> {
    static OPS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    OPS.get_or_init(Default::default)
}

/// Keeps one op resolvable while its git child runs. Dropping it forgets the
/// op, so an id cannot answer for a repo once the op that owned it has ended.
pub struct Registered(String);

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut ops) = ops().lock() {
            ops.remove(&self.0);
        }
    }
}

fn register(op_id: &str, repo: &str) -> Registered {
    if let Ok(mut ops) = ops().lock() {
        ops.insert(op_id.to_string(), repo.to_string());
    }
    Registered(op_id.to_string())
}

/// Point one git op at Tori's helper, when its remote is an https URL on a host
/// whose switch is on and whose account this repo resolves to.
///
/// `None` leaves git with the user's own helpers, which is where every other op
/// stays: ssh remotes, hosts with the switch off, a repo still waiting on an
/// account pick, and anything that does not name a single remote.
pub fn bridge(cmd: &mut Command, repo: &str, remote: &str, op_id: &str) -> Option<Registered> {
    if !serves(repo, remote) {
        return None;
    }
    // An empty value resets the helper list, so an osxkeychain entry for this
    // host cannot answer ahead of the account the user picked.
    cmd.arg("-c").arg("credential.helper=");
    cmd.arg("-c").arg(format!("credential.helper={}", helper_config()));
    Some(register(op_id, repo))
}

/// The same for a bare `git fetch`: with one remote configured, `--all` names
/// it after all. Several remotes can span hosts, and a helper answering for one
/// of them would be answering for all of them, so those stay on git's helpers.
pub fn bridge_all(cmd: &mut Command, repo: &str, op_id: &str) -> Option<Registered> {
    bridge(cmd, repo, &lone_remote(repo)?, op_id)
}

/// Whether a plain `git fetch` here is answered by Tori, which is what the
/// sidebar's "no credential helper" warning is really asking about.
pub fn answers_fetch(repo: &str) -> bool {
    lone_remote(repo).is_some_and(|remote| serves(repo, &remote))
}

fn serves(repo: &str, remote: &str) -> bool {
    let Some(url) = crate::git::remote_url(repo, remote).ok().flatten() else {
        return false;
    };
    // https only. An ssh remote authenticates with a key, and git would never
    // ask a credential helper for it anyway.
    url.starts_with("https://")
        && crate::forge::remote::parse(&url)
            .map(|r| crate::forge::commands::serves_git(repo, &r.host))
            .unwrap_or(false)
}

fn lone_remote(repo: &str) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(repo).arg("remote").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    match text.split_whitespace().collect::<Vec<_>>().as_slice() {
        [only] => Some((*only).to_string()),
        _ => None,
    }
}

/// The `credential.helper` value. A shell command (`!`), because a bare program
/// path cannot carry the mode argument, and single-quoted so a path with spaces
/// survives the shell.
fn helper_config() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    format!("!{} {ARG}", quoted(&exe.to_string_lossy()))
}

fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// What the socket server answers a credential request with: git's own
/// `key=value` block, or nothing.
///
/// Nothing is the fail-closed answer, and it fails *soft*: git moves on to the
/// askpass dialog, which is where this repo was before the switch.
pub fn answer(op_id: &str, host: &str) -> Option<String> {
    let repo = ops().lock().ok()?.get(op_id).cloned()?;
    // The host git asked for, not the one the op registered under: a redirect
    // to somewhere else must not be handed this account's token.
    let (username, token) = crate::forge::commands::git_credential(&repo, host)?;
    Some(format!("username={username}\npassword={token}\n"))
}

/// True when git invoked this binary as the credential helper. Checked *before*
/// the askpass marker, which this process also inherits from its git parent.
pub fn is_helper() -> bool {
    std::env::args().nth(1).as_deref() == Some(ARG)
}

/// The helper path: git writes its request on stdin and reads the answer off
/// stdout. Only `get` is answered. `store` and `erase` are read and dropped,
/// because the account is Tori's to hold and nothing here belongs in the user's
/// own credential store.
pub fn run_helper() -> i32 {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    if std::env::args().nth(2).as_deref() != Some("get") {
        return 0;
    }
    let Ok(sock) = std::env::var(crate::askpass::ENV_SOCK) else {
        return 1;
    };
    let token = std::env::var(crate::askpass::ENV_TOKEN).unwrap_or_default();
    let op_id = std::env::var(crate::askpass::ENV_OP).unwrap_or_default();
    let host = field(&input, "host").unwrap_or_default();

    match crate::askpass::ask_credential(Path::new(&sock), &token, &op_id, &host) {
        Ok(answer) if answer.is_empty() => 0,
        Ok(answer) => {
            let mut stdout = std::io::stdout();
            if stdout.write_all(answer.as_bytes()).is_err() || stdout.flush().is_err() {
                return 1;
            }
            0
        }
        Err(e) => {
            // Diagnostics to stderr only; stdout is the answer and nothing else.
            eprintln!("tori credential: {e}");
            1
        }
    }
}

/// One `key=value` line out of git's request block.
fn field(input: &str, key: &str) -> Option<String> {
    input.lines().find_map(|line| Some(line.strip_prefix(key)?.strip_prefix('=')?.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_with(remotes: &[(&str, &str)]) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tori-cred-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
        };
        git(&["init", "-q"]);
        for (name, url) in remotes {
            git(&["remote", "add", name, url]);
        }
        dir
    }

    #[test]
    fn the_helper_config_survives_a_path_with_spaces() {
        let value = helper_config();
        assert!(value.starts_with("!'"), "a shell command, so the path can carry the mode: {value}");
        assert!(value.ends_with(&format!("' {ARG}")), "got {value}");
        assert_eq!(quoted("/Apps/My App/tori"), "'/Apps/My App/tori'");
        assert_eq!(quoted("/it's/here"), r"'/it'\''s/here'");
    }

    #[test]
    fn a_request_is_read_by_key_and_an_unregistered_op_answers_nothing() {
        let input = "protocol=https\nhost=github.com\npath=skarif2/tori.git\n\n";
        assert_eq!(field(input, "host").as_deref(), Some("github.com"));
        assert_eq!(field(input, "username"), None);
        // The op id is the whole of a helper's authority to be answered, so one
        // no live op registered gets nothing, whatever host it names.
        assert_eq!(answer("op-nobody", "github.com"), None);
    }

    #[test]
    fn a_host_with_no_account_and_an_ssh_remote_keep_gits_own_helpers() {
        let dir = repo_with(&[("origin", "https://git.invalid.test/a/b.git")]);
        let repo = dir.to_string_lossy().into_owned();

        let mut https = Command::new("git");
        assert!(bridge(&mut https, &repo, "origin", "op-no-account").is_none());
        assert_eq!(https.get_args().count(), 0, "nothing configured, so nothing overridden");

        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["remote", "set-url", "origin", "git@github.com:skarif2/tori.git"])
            .output()
            .unwrap();
        let mut ssh = Command::new("git");
        assert!(bridge(&mut ssh, &repo, "origin", "op-ssh").is_none(), "a key, not a token");
        assert_eq!(ssh.get_args().count(), 0);

        assert!(!answers_fetch(&repo));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fetch_across_two_remotes_is_not_one_remotes_to_answer_for() {
        let one = repo_with(&[("origin", "https://github.com/skarif2/tori.git")]);
        assert_eq!(lone_remote(&one.to_string_lossy()).as_deref(), Some("origin"));

        let two = repo_with(&[
            ("origin", "https://github.com/skarif2/tori.git"),
            ("upstream", "https://gitlab.com/acme/widgets.git"),
        ]);
        let repo = two.to_string_lossy().into_owned();
        assert_eq!(lone_remote(&repo), None);
        let mut cmd = Command::new("git");
        assert!(bridge_all(&mut cmd, &repo, "op-all").is_none());
        assert!(!answers_fetch(&repo));

        std::fs::remove_dir_all(&one).ok();
        std::fs::remove_dir_all(&two).ok();
    }
}
