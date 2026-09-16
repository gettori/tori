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
// `useHttpPath`) path. Never the checkout. So an op Tori runs carries the
// account: `bridge` registers the op's root under its id, and the helper sends
// that id back. The registration lives exactly as long as the git child.
//
// Git in a process Tori spawned (a terminal tab, an agent) has no op. There
// `spawn_env` turns `useHttpPath` on, and the path names the repo the way a
// remote does, so the same per-repo account answers with nothing registered.
//
// It runs as this same binary re-exec'd, like `askpass`, and speaks over the
// askpass socket with the same per-session token: one door, authenticated once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use crate::forge::accounts::{self, AccountsFile};

/// argv marker, from `credential.helper = !'<exe>' --credential`.
pub const ARG: &str = "--credential";

/// The socket's coordinates in a process Tori spawns. Not askpass's own pair:
/// `askpass::is_helper` reads that as its mode switch, so a Tori binary started
/// from Tori's terminal would come up as the askpass helper.
pub const ENV_SOCK: &str = "TORI_CREDENTIAL_SOCK";
pub const ENV_TOKEN: &str = "TORI_CREDENTIAL_TOKEN";

static SOCKET: OnceLock<(String, String)> = OnceLock::new();

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

/// Called once the askpass socket is up, so spawned processes have one to ask.
pub fn publish(sock: &Path, token: &str) {
    let _ = SOCKET.set((sock.to_string_lossy().into_owned(), token.to_string()));
}

/// Environment for a process Tori spawns for the user, pointing git at Tori's
/// helper on each host whose switch is on. Read once at spawn, so a switch
/// flipped later does not reach a process already running.
pub fn spawn_env() -> Vec<(String, String)> {
    let Some((sock, token)) = SOCKET.get() else {
        return Vec::new();
    };
    let inherited = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|n| n.parse().ok()).unwrap_or(0);
    git_env(&accounts::load(), &helper_config(), sock, token, inherited)
}

fn git_env(file: &AccountsFile, helper: &str, sock: &str, token: &str, inherited: usize) -> Vec<(String, String)> {
    let hosts: Vec<&String> = file.hosts.keys().filter(|host| accounts::git_credentials(file, host)).collect();
    if hosts.is_empty() {
        return Vec::new();
    }
    let mut env = vec![(ENV_SOCK.to_string(), sock.to_string()), (ENV_TOKEN.to_string(), token.to_string())];
    // Numbered on from whatever list the process inherited, which renumbering
    // from zero would silently cut short.
    let mut n = inherited;
    for host in hosts {
        let url = format!("credential.https://{host}");
        // An empty value resets the helper list, so an osxkeychain entry for this
        // host cannot answer ahead of the account the user picked.
        for (key, value) in [("helper", ""), ("helper", helper), ("useHttpPath", "true")] {
            env.push((format!("GIT_CONFIG_KEY_{n}"), format!("{url}.{key}")));
            env.push((format!("GIT_CONFIG_VALUE_{n}"), value.to_string()));
            n += 1;
        }
    }
    env.push(("GIT_CONFIG_COUNT".to_string(), n.to_string()));
    env
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
/// Nothing is the fail-closed answer, and it fails *soft*: git moves on to its
/// next way of asking, the askpass dialog for Tori's own ops and the terminal
/// prompt anywhere else.
pub fn answer(op_id: &str, host: &str, path: &str) -> Option<String> {
    answer_with(
        op_id,
        host,
        path,
        crate::forge::commands::git_credential,
        crate::forge::commands::git_credential_at,
    )
}

fn answer_with(
    op_id: &str,
    host: &str,
    path: &str,
    by_checkout: impl Fn(&str, &str) -> Option<(String, String)>,
    by_path: impl Fn(&str, &str) -> Option<(String, String)>,
) -> Option<String> {
    let repo = ops().lock().ok()?.get(op_id).cloned();
    let (username, token) = match repo {
        // The host git asked for, not the one the op registered under: a
        // redirect to somewhere else must not be handed this account's token.
        Some(repo) => by_checkout(&repo, host)?,
        None => by_path(host, path)?,
    };
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
    // Askpass's pair first: an op id only exists on the socket that pair names,
    // and a Tori started from Tori's terminal inherits the other pair as well.
    let Some((sock, token)) = socket_in_env(crate::askpass::ENV_SOCK, crate::askpass::ENV_TOKEN)
        .or_else(|| socket_in_env(ENV_SOCK, ENV_TOKEN))
    else {
        return 1;
    };
    let op_id = std::env::var(crate::askpass::ENV_OP).unwrap_or_default();
    let host = field(&input, "host").unwrap_or_default();
    let path = field(&input, "path").unwrap_or_default();

    match crate::askpass::ask_credential(Path::new(&sock), &token, &op_id, &host, &path) {
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

fn socket_in_env(sock: &str, token: &str) -> Option<(String, String)> {
    Some((std::env::var(sock).ok()?, std::env::var(token).unwrap_or_default()))
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
    fn a_request_is_read_by_key_and_one_naming_no_repo_answers_nothing() {
        let input = "protocol=https\nhost=github.com\npath=skarif2/tori.git\n\n";
        assert_eq!(field(input, "host").as_deref(), Some("github.com"));
        assert_eq!(field(input, "username"), None);
        assert_eq!(answer("op-nobody", "github.com", ""), None);
    }

    #[test]
    fn git_with_no_op_is_answered_from_the_path_and_a_registered_op_still_wins() {
        let by_checkout = |_: &str, _: &str| Some(("x-access-token".to_string(), "from-checkout".to_string()));
        let by_path = |_: &str, _: &str| Some(("oauth2".to_string(), "from-path".to_string()));
        let path = "skarif2/masterchef.git";

        assert_eq!(
            answer_with("", "gitlab.com", path, by_checkout, by_path).as_deref(),
            Some("username=oauth2\npassword=from-path\n")
        );
        let _op = register("op-registered", "/repos/masterchef");
        assert_eq!(
            answer_with("op-registered", "gitlab.com", path, by_checkout, by_path).as_deref(),
            Some("username=x-access-token\npassword=from-checkout\n")
        );
    }

    #[test]
    fn a_spawned_process_asks_tori_only_on_hosts_whose_switch_is_on() {
        use crate::forge::accounts::Provider;
        let mut file = AccountsFile::default();
        for (input, provider) in [("github.com", Provider::Github), ("gitlab.com", Provider::Gitlab)] {
            let (base_url, host) = accounts::normalize_base_url(input).unwrap();
            accounts::add_account(&mut file, provider, &base_url, &host, "skarif2", None).unwrap();
        }
        accounts::set_git_credentials(&mut file, "gitlab.com", true);

        let helper = "!'/Apps/Tori.app/tori' --credential";
        let env: HashMap<String, String> = git_env(&file, helper, "/tmp/s", "tok", 2).into_iter().collect();
        assert_eq!(env["GIT_CONFIG_COUNT"], "5", "three entries after the two inherited");
        let entries: Vec<(&str, &str)> = (2..5)
            .map(|n| (env[&format!("GIT_CONFIG_KEY_{n}")].as_str(), env[&format!("GIT_CONFIG_VALUE_{n}")].as_str()))
            .collect();
        assert_eq!(
            entries,
            [
                ("credential.https://gitlab.com.helper", ""),
                ("credential.https://gitlab.com.helper", helper),
                ("credential.https://gitlab.com.useHttpPath", "true"),
            ]
        );
        assert_eq!((env[ENV_SOCK].as_str(), env[ENV_TOKEN].as_str()), ("/tmp/s", "tok"));
        assert!(!env.contains_key(crate::askpass::ENV_SOCK));

        assert!(git_env(&AccountsFile::default(), helper, "/tmp/s", "tok", 0).is_empty());
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
