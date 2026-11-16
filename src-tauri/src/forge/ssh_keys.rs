//! The SSH keys an account can authenticate or sign with. Tori handles public
//! halves only: a private key is named by path for ssh and ssh-keygen to open.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub path: String,
    pub label: String,
    pub in_agent: bool,
    pub file: KeyFile,
}

/// The private half beside a public key file, as far as Tori can tell without
/// reading it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyFile {
    None,
    Plain,
    Passphrase,
}

fn ssh_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh")
}

// Written out so ssh and git can be pointed at an agent's key like any other.
fn agent_dir() -> PathBuf {
    super::identity::files_dir().join("agent-keys")
}

fn blob(line: &str) -> Option<String> {
    let mut parts = line.split_whitespace();
    let kind = parts.next()?;
    let body = parts.next()?;
    ["ssh-", "ecdsa-", "sk-"]
        .iter()
        .any(|prefix| kind.starts_with(prefix))
        .then(|| format!("{kind} {body}"))
}

fn agent_lines() -> Vec<String> {
    let Ok(out) = Command::new("ssh-add").arg("-L").output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

fn fingerprint(public: &Path) -> Option<String> {
    let out = Command::new("ssh-keygen").arg("-lf").arg(public).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn private_for(public: &Path) -> Option<PathBuf> {
    let private = public.with_extension("");
    (public.extension().is_some_and(|e| e == "pub") && private.is_file()).then_some(private)
}

// A public half makes ssh and git ask the agent for the private one.
pub fn private_or_public(public: &str) -> String {
    let public = Path::new(public);
    private_for(public)
        .unwrap_or_else(|| public.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn key_file(public: &Path) -> KeyFile {
    let Some(private) = private_for(public) else {
        return KeyFile::None;
    };
    // ssh-keygen opens the private key in its own process, never in Tori's.
    let opens_empty = Command::new("ssh-keygen")
        .args(["-y", "-P", ""])
        .arg("-f")
        .arg(private)
        .output()
        .is_ok_and(|out| out.status.success());
    if opens_empty {
        KeyFile::Plain
    } else {
        KeyFile::Passphrase
    }
}

pub fn list() -> Result<Vec<SshKey>, String> {
    let agent = agent_lines();
    let agent_blobs: Vec<String> = agent.iter().filter_map(|l| blob(l)).collect();
    let mut keys = Vec::new();
    let mut seen = Vec::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(ssh_dir())
        .map(|dir| dir.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.sort();
    for public in files.iter().filter(|p| p.extension().is_some_and(|e| e == "pub")) {
        let Some(key) = std::fs::read_to_string(public).ok().and_then(|text| blob(&text)) else {
            continue;
        };
        keys.push(SshKey {
            path: public.to_string_lossy().into_owned(),
            label: fingerprint(public).unwrap_or_else(|| public.to_string_lossy().into_owned()),
            in_agent: agent_blobs.contains(&key),
            file: key_file(public),
        });
        seen.push(key);
    }
    for line in &agent {
        let Some(key) = blob(line) else { continue };
        if seen.contains(&key) {
            continue;
        }
        let public = write_agent_key(&key, line)?;
        keys.push(SshKey {
            label: fingerprint(&public).unwrap_or_else(|| line.clone()),
            path: public.to_string_lossy().into_owned(),
            in_agent: true,
            file: KeyFile::None,
        });
        seen.push(key);
    }
    Ok(keys)
}

fn write_agent_key(key: &str, line: &str) -> Result<PathBuf, String> {
    let dir = agent_dir();
    let alnum: String = key.chars().filter(char::is_ascii_alphanumeric).collect();
    let path = dir.join(format!("{}.pub", &alnum[alnum.len().saturating_sub(16)..]));
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&path, format!("{}\n", line.trim())))
        .map_err(|e| format!("Could not save an agent key's public half to {}: {e}", path.display()))?;
    Ok(path)
}

pub fn is_known(path: &str) -> bool {
    let path = Path::new(path);
    path.extension().is_some_and(|e| e == "pub")
        && path.is_file()
        && (path.parent() == Some(ssh_dir().as_path()) || path.parent() == Some(agent_dir().as_path()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum KeyTest {
    Ok { login: String },
    Mismatch { login: String },
    Failed { message: String },
}

pub fn test(host: &str, public: &str, expected: Option<&str>) -> KeyTest {
    // Without the user's ssh config, so no other key can answer for this one.
    let out = Command::new("ssh")
        .args(["-F", "/dev/null", "-T"])
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ])
        .args(["-o", "ConnectTimeout=10"])
        .arg("-i")
        .arg(private_or_public(public))
        .arg(format!("git@{host}"))
        .output();
    let out = match out {
        Ok(out) => out,
        Err(e) => return KeyTest::Failed { message: e.to_string() },
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    match login_in(&text) {
        Some(login) if expected.is_none_or(|e| e.eq_ignore_ascii_case(&login)) => KeyTest::Ok { login },
        Some(login) => KeyTest::Mismatch { login },
        None => KeyTest::Failed {
            message: text.lines().last().unwrap_or("ssh gave no answer").trim().to_string(),
        },
    }
}

/// GitHub answers "Hi login!", GitLab "Welcome to GitLab, @login!".
fn login_in(text: &str) -> Option<String> {
    let rest = text
        .split("Hi ")
        .nth(1)
        .or_else(|| text.split("Welcome to GitLab, @").nth(1))?;
    let login: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    (!login.is_empty()).then_some(login)
}
