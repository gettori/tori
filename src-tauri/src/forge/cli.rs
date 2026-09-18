//! The GitHub CLI's own login, read rather than re-minted.
//!
//! An organisation that has not approved Tori's OAuth application still answers
//! `gh`, whose application it approved years ago, so on a GitHub host the token
//! `gh` already holds reaches repositories Tori's own sign-in cannot. Tori only
//! reads it: it never runs `gh auth login`, and it never mints anything in
//! `gh`'s name.

use crate::env;

/// What one `gh` run answered: whether it succeeded, and what it printed.
pub type Answer = Option<(bool, Vec<u8>)>;

/// Whether `gh` is on this machine at all, without running it.
///
/// A path lookup, not a spawn: the only question the sign-in surfaces ask is
/// whether offering the CLI route is worth offering, and a process per ask would
/// put that on the poll path.
pub fn installed() -> bool {
    env::resolve_binary("gh").is_some()
}

/// The token `gh` holds for `host`, if it is installed and logged in there.
pub fn token(host: &str) -> Option<String> {
    token_from(host, spawn)
}

/// `gh` prints the token on stdout and exits zero, or explains itself on stderr
/// and exits non-zero. Both halves are checked: an explanation that reached
/// stdout would otherwise be stored as a credential, and so would the empty
/// string.
pub fn token_from(host: &str, run: impl FnOnce(&str) -> Answer) -> Option<String> {
    let (ok, stdout) = run(host)?;
    if !ok {
        return None;
    }
    let token = String::from_utf8_lossy(&stdout).trim().to_string();
    (!token.is_empty() && !token.contains(char::is_whitespace)).then_some(token)
}

/// `None` where `gh` is not installed, which is not a failure: it is the answer
/// that sends the caller to the token screen.
fn spawn(host: &str) -> Answer {
    let gh = env::resolve_binary("gh")?;
    let out = std::process::Command::new(gh)
        .args(["auth", "token", "--hostname", host])
        .output()
        .ok()?;
    Some((out.status.success(), out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_read_only_from_a_run_that_actually_succeeded() {
        let logged_in = |_: &str| Some((true, b"gho_from_the_cli\n".to_vec()));
        assert_eq!(token_from("github.com", logged_in), Some("gho_from_the_cli".into()));

        // Logged out: gh explains on stderr and exits 1, so stdout is empty.
        assert_eq!(token_from("github.com", |_: &str| Some((false, Vec::new()))), None);

        // Not installed at all.
        assert_eq!(token_from("github.com", |_: &str| None), None);
    }

    #[test]
    fn a_sentence_on_stdout_is_never_mistaken_for_a_credential() {
        // gh has printed advice on stdout before now. Storing "You are not
        // logged into any GitHub hosts" as a token would sign the user in to an
        // account that rejects every call.
        let chatty = |_: &str| Some((true, b"You are not logged into any GitHub hosts\n".to_vec()));
        assert_eq!(token_from("github.com", chatty), None);
        assert_eq!(token_from("github.com", |_: &str| Some((true, b"  \n".to_vec()))), None);
    }

    #[test]
    fn the_host_reaches_gh_verbatim() {
        // Enterprise is the case that matters: `gh auth token` with no hostname
        // answers for github.com, so a GHE account would silently receive the
        // wrong token.
        let asked = std::cell::RefCell::new(String::new());
        let record = |host: &str| {
            asked.borrow_mut().push_str(host);
            Some((true, b"gho_x".to_vec()))
        };
        token_from("ghe.acme.test", record);
        assert_eq!(asked.into_inner(), "ghe.acme.test");
    }
}
