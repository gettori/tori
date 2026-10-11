//! What the files a session changed say about how risky the change is.

use std::path::Path;

use crate::checkpoint::CheckpointFile;
use crate::secret_watch::Rules;

const MANIFESTS: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Package.swift",
    "Package.resolved",
    "mix.exs",
    "mix.lock",
    "pubspec.yaml",
    "pubspec.lock",
];

const CI_DIRS: &[&str] = &[".github/workflows/", ".github/actions/", ".circleci/", ".buildkite/"];

const CI_FILES: &[&str] = &[
    ".gitlab-ci.yml",
    "Jenkinsfile",
    "azure-pipelines.yml",
    ".travis.yml",
    "bitbucket-pipelines.yml",
];

const AUTH_WORDS: &[&str] = &[
    "auth",
    "authn",
    "authz",
    "authentication",
    "authorization",
    "oauth",
    "login",
    "signin",
    "credential",
    "credentials",
    "permission",
    "permissions",
    "rbac",
    "acl",
    "jwt",
    "sso",
    "saml",
];

const TEST_DIRS: &[&str] = &["test", "tests", "__tests__", "spec", "specs"];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct FileSignals {
    pub deleted_tests: u32,
    pub dependencies: u32,
    pub sensitive: u32,
    pub shared: u32,
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_test(path: &str) -> bool {
    let mut parts: Vec<&str> = path.split('/').collect();
    let name = parts.pop().unwrap_or_default();
    if parts.iter().any(|p| TEST_DIRS.contains(p)) {
        return true;
    }
    let stem = name.split('.').next().unwrap_or(name);
    name.contains(".test.")
        || name.contains(".spec.")
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || stem.ends_with("Test")
        || stem.ends_with("Tests")
}

fn is_manifest(path: &str) -> bool {
    let name = name_of(path);
    MANIFESTS.contains(&name) || (name.starts_with("requirements") && name.ends_with(".txt"))
}

fn is_ci(path: &str) -> bool {
    CI_DIRS.iter().any(|d| path.starts_with(d)) || CI_FILES.contains(&name_of(path))
}

// Whole words of a path, so `author.rs` is not an auth file but `auth_guard.rs`
// and `OAuthClient.ts` are.
fn is_auth(path: &str) -> bool {
    path.split(|c: char| !c.is_ascii_alphanumeric())
        .flat_map(split_camel)
        .any(|word| AUTH_WORDS.contains(&word.to_ascii_lowercase().as_str()))
}

fn split_camel(word: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = word.as_bytes();
    for i in 1..bytes.len() {
        let next_lower = bytes.get(i + 1).is_some_and(u8::is_ascii_lowercase);
        let boundary = bytes[i].is_ascii_uppercase() && (bytes[i - 1].is_ascii_lowercase() || next_lower);
        if boundary {
            out.push(&word[start..i]);
            start = i;
        }
    }
    out.push(&word[start..]);
    out.retain(|w| !w.is_empty());
    out
}

fn is_sensitive(path: &str, repo: &Path, rules: &Rules) -> bool {
    is_ci(path) || is_auth(path) || rules.matches(path, Some(repo))
}

pub(super) fn file_signals(files: &[CheckpointFile], repo: &Path, rules: &Rules) -> FileSignals {
    let count = |hit: &dyn Fn(&CheckpointFile) -> bool| files.iter().filter(|f| hit(f)).count() as u32;
    FileSignals {
        deleted_tests: count(&|f| f.status == "deleted" && is_test(&f.path)),
        dependencies: count(&|f| is_manifest(&f.path)),
        sensitive: count(&|f| is_sensitive(&f.path, repo, rules)),
        shared: count(&|f| !f.shared_with.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn file(path: &str, status: &str) -> CheckpointFile {
        CheckpointFile {
            path: path.into(),
            status: status.into(),
            added: 12,
            removed: 3,
            shared_with: Vec::new(),
            unattributed: false,
        }
    }

    fn rules() -> Rules {
        Rules::new(PathBuf::from("/Users/me"), &[])
    }

    fn signals(files: &[CheckpointFile]) -> FileSignals {
        file_signals(files, Path::new("/work/app"), &rules())
    }

    #[test]
    fn each_kind_of_risky_file_fires_its_signal_once() {
        let mut shared = file("src/review/mod.rs", "modified");
        shared.shared_with = vec!["other-session".into()];
        let got = signals(&[
            file("src/review/paths_test.rs", "deleted"),
            file("pnpm-lock.yaml", "modified"),
            file(".github/workflows/ci.yml", "modified"),
            shared,
        ]);
        assert_eq!(
            got,
            FileSignals {
                deleted_tests: 1,
                dependencies: 1,
                sensitive: 1,
                shared: 1,
            }
        );
    }

    #[test]
    fn auth_and_secret_paths_are_sensitive() {
        let got = signals(&[
            file("src/auth/session_guard.rs", "modified"),
            file("web/OAuthClient.ts", "modified"),
            file("config/.env.production", "added"),
        ]);
        assert_eq!(got.sensitive, 3);
    }

    #[test]
    fn a_plain_source_edit_fires_nothing() {
        let got = signals(&[
            file("src/author.rs", "modified"),
            file("src/panels/Inbox/InboxView.tsx", "modified"),
            file("src/utils/testing_notes.md", "deleted"),
        ]);
        assert_eq!(got, FileSignals::default());
    }

    #[test]
    fn a_test_that_is_only_edited_is_not_a_deleted_test() {
        let got = signals(&[file("tests/review.rs", "modified"), file("src/a.test.ts", "added")]);
        assert_eq!(got.deleted_tests, 0);
    }
}
