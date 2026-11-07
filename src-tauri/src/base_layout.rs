use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "pubspec.yaml",
];

pub(crate) fn has_git(dir: &Path) -> bool {
    dir.join(".git").exists() || dir.join(".bare").exists()
}

fn has_manifest(dir: &Path) -> bool {
    if MANIFESTS.iter().any(|m| dir.join(m).is_file()) {
        return true;
    }
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".xcodeproj"))
    })
}

pub(crate) fn is_project(dir: &Path) -> bool {
    has_git(dir) || has_manifest(dir)
}

fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !basename(p).starts_with('.'))
        .collect()
}

fn basename(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn gitdir_outside(folder: &Path, parent: &Path) -> bool {
    let Ok(link) = std::fs::read_to_string(folder.join(".git")) else {
        return false;
    };
    let Some(gitdir) = link.trim().strip_prefix("gitdir:") else {
        return false;
    };
    let gitdir = folder.join(gitdir.trim());
    !(gitdir.starts_with(parent) || canon(&gitdir).starts_with(canon(parent)))
}

fn independent_repo(child: &Path, parent: &Path) -> bool {
    child.join(".bare").exists() || child.join(".git").is_dir() || gitdir_outside(child, parent)
}

pub(crate) fn worktree_of_another_repo(dir: &Path) -> bool {
    gitdir_outside(dir, dir)
}

// A manifest alone never demotes a top-level folder, and neither does a
// versioned folder of independent repos, so an existing space that happens to
// have either stays a space.
fn top_level_project(dir: &Path) -> bool {
    if dir.join(".bare").exists() {
        return true;
    }
    if !dir.join(".git").exists() {
        return false;
    }
    !subdirs(dir).iter().any(|c| independent_repo(c, dir))
}

// A top-level folder the setup scan offers to group. Wider than discovery's
// rule, since the user confirms each one, but a manifest still never claims a
// folder of repos.
pub(crate) fn setup_would_group(dir: &Path) -> bool {
    top_level_project(dir) || (!has_git(dir) && has_manifest(dir) && !subdirs(dir).iter().any(|c| has_git(c)))
}

fn container(dir: &Path) -> bool {
    !is_project(dir) && subdirs(dir).iter().any(|c| has_git(c))
}

pub(crate) struct Rules<'a> {
    ignore: &'a [String],
    not_spaces: &'a [String],
    attached: HashSet<PathBuf>,
}

impl<'a> Rules<'a> {
    pub fn new(ignore: &'a [String], not_spaces: &'a [String], attached: &[PathBuf]) -> Self {
        Self {
            ignore,
            not_spaces,
            attached: attached.iter().map(|p| canon(p)).collect(),
        }
    }

    pub fn skipped(&self, name: &str) -> bool {
        name.starts_with('.') || self.ignore.iter().any(|i| i == name)
    }

    fn attached(&self, dir: &Path) -> bool {
        !self.attached.is_empty() && self.attached.contains(&canon(dir))
    }

    pub fn is_space(&self, dir: &Path) -> bool {
        let name = basename(dir);
        dir.is_dir()
            && !self.skipped(&name)
            && !self.not_spaces.iter().any(|n| n == &name)
            && !self.attached(dir)
            && !top_level_project(dir)
    }

    pub fn is_space_project(&self, dir: &Path) -> bool {
        dir.is_dir() && !self.skipped(&basename(dir)) && !container(dir)
    }

    pub fn spaces(&self, root: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| self.is_space(p))
            .collect()
    }

    pub fn projects(&self, space: &Path) -> Vec<PathBuf> {
        let entries = match std::fs::read_dir(space) {
            Ok(entries) => entries,
            Err(e) => {
                eprintln!("tori: cannot list space {}: {e}", space.display());
                return Vec::new();
            }
        };
        entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| self.is_space_project(p))
            .collect()
    }

    // Attachable ones only, so never a worktree of another repo. Only one
    // level into a container: deeper projects are the setup scan's to find,
    // and this runs on every resolve.
    pub fn misplaced(&self, root: &Path, spaces: &[PathBuf]) -> Vec<PathBuf> {
        let attachable =
            |dir: &PathBuf| !self.skipped(&basename(dir)) && !self.attached(dir) && !worktree_of_another_repo(dir);
        let loose = subdirs(root)
            .into_iter()
            .filter(|top| attachable(top) && top_level_project(top));
        let in_containers = spaces
            .iter()
            .flat_map(|space| subdirs(space))
            .filter(|dir| !self.skipped(&basename(dir)) && container(dir))
            .flat_map(|dir| subdirs(&dir))
            .filter(|c| has_git(c) && attachable(c));
        let mut found: Vec<PathBuf> = loose.chain(in_containers).collect();
        found.sort();
        found
    }

    pub fn discovered(&self, root: &Path, folder: &Path) -> bool {
        let (root, folder) = (canon(root), canon(folder));
        let Ok(rel) = folder.strip_prefix(&root) else {
            return false;
        };
        let parts: Vec<_> = rel.components().collect();
        match parts.len() {
            0 => true,
            1 => self.is_space(&folder) && !setup_would_group(&folder),
            2 => folder.parent().is_some_and(|space| self.is_space(space)) && self.is_space_project(&folder),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-base-layout-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn repo(dir: &Path) {
        fs::create_dir_all(dir.join(".git")).unwrap();
    }

    fn worktree_of(dir: &Path, gitdir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    }

    fn names(paths: Vec<PathBuf>) -> Vec<String> {
        let mut out: Vec<String> = paths.iter().map(|p| basename(p)).collect();
        out.sort();
        out
    }

    #[test]
    fn each_marker_makes_a_project_and_a_bare_folder_does_not() {
        let root = tmp();
        for (dir, file) in [
            ("node", "package.json"),
            ("rust", "Cargo.toml"),
            ("go", "go.mod"),
            ("py", "pyproject.toml"),
            ("java", "pom.xml"),
            ("gradle", "build.gradle"),
            ("ruby", "Gemfile"),
            ("php", "composer.json"),
            ("dart", "pubspec.yaml"),
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::write(root.join(dir).join(file), "").unwrap();
            assert!(is_project(&root.join(dir)), "{file}");
        }
        fs::create_dir_all(root.join("ios/App.xcodeproj")).unwrap();
        assert!(is_project(&root.join("ios")));
        repo(&root.join("git"));
        assert!(is_project(&root.join("git")));
        fs::create_dir_all(root.join("bare/.bare")).unwrap();
        assert!(is_project(&root.join("bare")));
        fs::create_dir_all(root.join("plain")).unwrap();
        assert!(!is_project(&root.join("plain")));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn top_level_projects_are_not_spaces_but_versioned_and_manifest_spaces_are() {
        let root = tmp();
        repo(&root.join("repo"));
        fs::create_dir_all(root.join("proj/.bare")).unwrap();
        worktree_of(&root.join("proj/main"), &root.join("proj/.bare/worktrees/main"));
        repo(&root.join("personal"));
        repo(&root.join("personal/dotfiles"));
        fs::create_dir_all(root.join("tools")).unwrap();
        fs::write(root.join("tools/package.json"), "{}").unwrap();
        fs::create_dir_all(root.join("work")).unwrap();
        let rules = Rules::new(&[], &[], &[]);
        assert_eq!(names(rules.spaces(&root)), ["personal", "tools", "work"]);
        assert_eq!(names(rules.misplaced(&root, &rules.spaces(&root))), ["proj", "repo"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_plain_clone_with_its_own_worktree_inside_is_still_one_project() {
        let root = tmp();
        repo(&root.join("app"));
        worktree_of(&root.join("app/feature"), &root.join("app/.git/worktrees/feature"));
        assert!(!Rules::new(&[], &[], &[]).is_space(&root.join("app")));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_container_of_repos_is_skipped_but_a_folder_of_manifests_stays() {
        let root = tmp();
        repo(&root.join("work/client/repo"));
        for part in ["frontend", "backend"] {
            fs::create_dir_all(root.join("work/myapp").join(part)).unwrap();
            fs::write(root.join("work/myapp").join(part).join("package.json"), "{}").unwrap();
        }
        repo(&root.join("work/api"));
        let rules = Rules::new(&[], &[], &[]);
        assert_eq!(names(rules.spaces(&root)), ["work"]);
        assert_eq!(names(rules.projects(&root.join("work"))), ["api", "myapp"]);
        assert_eq!(names(rules.misplaced(&root, &rules.spaces(&root))), ["repo"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn not_spaces_hides_only_top_level_names() {
        let root = tmp();
        fs::create_dir_all(root.join("screenshots")).unwrap();
        fs::create_dir_all(root.join("work/screenshots")).unwrap();
        let hidden = vec!["screenshots".to_string()];
        let rules = Rules::new(&[], &hidden, &[]);
        assert_eq!(names(rules.spaces(&root)), ["work"]);
        assert_eq!(names(rules.projects(&root.join("work"))), ["screenshots"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_attached_folder_is_never_a_space_or_misplaced_but_a_space_project_stays() {
        let root = tmp();
        fs::create_dir_all(root.join("loose")).unwrap();
        fs::write(root.join("loose/package.json"), "{}").unwrap();
        repo(&root.join("repo"));
        repo(&root.join("work/client/deep"));
        repo(&root.join("work/api"));
        let attached = [
            root.join("loose"),
            root.join("repo"),
            root.join("work/client/deep"),
            root.join("work/api"),
        ];
        let rules = Rules::new(&[], &[], &attached);
        assert_eq!(names(rules.spaces(&root)), ["work"]);
        assert_eq!(names(rules.projects(&root.join("work"))), ["api"]);
        assert!(rules.misplaced(&root, &rules.spaces(&root)).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn discovered_names_the_base_spaces_and_their_projects_only() {
        let root = tmp();
        repo(&root.join("loose"));
        repo(&root.join("work/api"));
        repo(&root.join("work/client/deep"));
        let rules = Rules::new(&[], &[], &[]);
        assert!(rules.discovered(&root, &root));
        assert!(rules.discovered(&root, &root.join("work")));
        assert!(rules.discovered(&root, &root.join("work/api")));
        assert!(!rules.discovered(&root, &root.join("loose")));
        assert!(!rules.discovered(&root, &root.join("work/client")));
        assert!(!rules.discovered(&root, &root.join("work/client/deep")));
        fs::remove_dir_all(&root).unwrap();
    }
}
