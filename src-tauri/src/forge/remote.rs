//! A git remote as the forge layer reads it: which host, and which repo on it.

use super::model::RepoRef;
use super::ForgeError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    /// Lowercase, with any user and port stripped, as account hosts are keyed.
    pub host: String,
    pub repo: RepoRef,
}

impl Remote {
    /// The per-repo account pick key. Lowercase because both GitHub and GitLab
    /// route paths case-insensitively, so two spellings are one repo.
    pub fn key(&self) -> String {
        format!("{}/{}/{}", self.host, self.repo.owner, self.repo.repo).to_lowercase()
    }
}

pub fn canonical_host(host: &str) -> String {
    let host = host.to_ascii_lowercase();
    if host == "www.github.com" {
        return "github.com".into();
    }
    host
}

/// Accepts `https://`, `git@` scp syntax and `ssh://` on any host. Whether
/// anything serves that host is the resolver's question.
pub fn parse(url: &str) -> Result<Remote, ForgeError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(ForgeError::NoRemote);
    }
    // `git@host:owner/repo.git`, which is not a URL and will not parse as one.
    let (host, path) = if let Some(rest) = url.strip_prefix("git@") {
        match rest.split_once(':') {
            Some((host, path)) => (host.to_string(), path.to_string()),
            None => return Err(ForgeError::UnsupportedRemote { host: rest.to_string() }),
        }
    } else {
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .or_else(|| url.strip_prefix("ssh://git@"))
            .or_else(|| url.strip_prefix("ssh://"))
            .ok_or_else(|| ForgeError::UnsupportedRemote { host: url.to_string() })?;
        match rest.split_once('/') {
            Some((host, path)) => (host.to_string(), path.to_string()),
            None => return Err(ForgeError::UnsupportedRemote { host: rest.to_string() }),
        }
    };

    // Strip a `user@` prefix and any port, so `git@github.com` and
    // `github.com:22` both resolve to the same host.
    let host = host.rsplit('@').next().unwrap_or(&host).to_string();
    let host = canonical_host(host.split(':').next().unwrap_or(&host));

    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut bits = path.splitn(2, '/');
    let owner = bits.next().unwrap_or_default();
    let repo = bits.next().unwrap_or_default();
    // Both go into API paths on the account's host, where `..` or a `?` would
    // address another endpoint with the same token.
    let plain = |segment: &str| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.contains(|c: char| c.is_whitespace() || matches!(c, '?' | '#' | '%' | '\\'))
    };
    if !plain(owner) || !repo.split('/').all(plain) {
        return Err(ForgeError::UnsupportedRemote { host });
    }
    Ok(Remote { host, repo: RepoRef { owner: owner.to_string(), repo: repo.to_string() } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tori() -> Remote {
        Remote {
            host: "github.com".into(),
            repo: RepoRef { owner: "skarif2".into(), repo: "tori".into() },
        }
    }

    #[test]
    fn every_remote_shape_resolves_to_the_same_repo() {
        for url in [
            "https://github.com/skarif2/tori.git",
            "https://github.com/skarif2/tori",
            "git@github.com:skarif2/tori.git",
            "ssh://git@github.com/skarif2/tori.git",
            "ssh://git@github.com:22/skarif2/tori.git",
            "https://www.github.com/skarif2/tori/",
        ] {
            assert_eq!(parse(url).unwrap(), tori(), "failed on {url}");
        }
    }

    #[test]
    fn any_host_parses_and_a_malformed_remote_is_still_refused() {
        assert_eq!(parse("git@gitlab.com:acme/widgets.git").unwrap().host, "gitlab.com");
        assert_eq!(parse(""), Err(ForgeError::NoRemote));
        // A host with no repo path is unsupported, not a panic.
        assert!(parse("https://github.com/skarif2").is_err());
    }

    #[test]
    fn the_ssh_and_https_forms_of_one_repo_share_a_pick_key() {
        let ssh = parse("git@GitHub.com:Skarif2/tori.git").unwrap();
        let https = parse("https://user@github.com:443/skarif2/tori").unwrap();
        assert_eq!(ssh.key(), https.key());
        assert_eq!(ssh.key(), "github.com/skarif2/tori");
    }
}
