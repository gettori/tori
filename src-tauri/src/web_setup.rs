use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const PLUGIN: &str = "code-inspector-plugin";
const IMPORT: &str = "import { codeInspectorPlugin } from \"code-inspector-plugin\";";
const DEPTH: usize = 4;
const SKIPPED: &[&str] = &["node_modules", "dist", "build", "out", "target", "coverage"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct App {
    /// The package's folder relative to the worktree, `""` for the worktree itself.
    pub dir: String,
    pub framework: &'static str,
    pub bundler: &'static str,
    /// The config file the snippet goes in, relative to `dir`.
    pub config: String,
    pub snippet: String,
    pub install: String,
    /// The plugin is already a dependency.
    pub plugin: bool,
    /// The framework marks elements with their own file and line, so the plugin adds nothing.
    pub own_lines: bool,
}

fn has(deps: &Value, name: &str) -> bool {
    ["dependencies", "devDependencies"]
        .iter()
        .any(|k| deps[k].get(name).is_some())
}

fn major(deps: &Value, name: &str) -> Option<u32> {
    let range = ["dependencies", "devDependencies"]
        .iter()
        .find_map(|k| deps[k][name].as_str())?;
    range
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn first_config(dir: &Path, stem: &str) -> String {
    ["ts", "mts", "js", "mjs", "cjs"]
        .iter()
        .map(|ext| format!("{stem}.{ext}"))
        .find(|name| dir.join(name).is_file())
        .unwrap_or_else(|| format!("{stem}.ts"))
}

fn plugins_line(bundler: &str) -> String {
    format!("{IMPORT}\nplugins: [codeInspectorPlugin({{ bundler: \"{bundler}\" }})],")
}

fn kind(pkg: &Value, dir: &Path) -> Option<(&'static str, &'static str, String, String)> {
    let dev = pkg["scripts"]["dev"].as_str().unwrap_or_default();
    if has(pkg, "next") {
        let turbopack = if dev.contains("--webpack") {
            false
        } else {
            dev.contains("--turbo") || major(pkg, "next").is_some_and(|m| m >= 16)
        };
        let config = first_config(dir, "next.config");
        return Some(if turbopack {
            (
                "Next",
                "Turbopack",
                config,
                format!("{IMPORT}\nturbopack: {{ rules: codeInspectorPlugin({{ bundler: \"turbopack\" }}) }},"),
            )
        } else {
            (
                "Next",
                "webpack",
                config,
                format!(
                    "{IMPORT}\nwebpack: (config) => {{ config.plugins.push(codeInspectorPlugin({{ bundler: \"webpack\" }})); return config; }},"
                ),
            )
        });
    }
    if has(pkg, "nuxt") {
        let snippet = format!("{IMPORT}\nvite: {{ plugins: [codeInspectorPlugin({{ bundler: \"vite\" }})] }},");
        return Some(("Nuxt", "Vite", first_config(dir, "nuxt.config"), snippet));
    }
    if has(pkg, "astro") {
        let snippet = format!("{IMPORT}\nvite: {{ plugins: [codeInspectorPlugin({{ bundler: \"vite\" }})] }},");
        return Some(("Astro", "Vite", first_config(dir, "astro.config"), snippet));
    }
    let framework = [
        ("@sveltejs/kit", "SvelteKit"),
        ("svelte", "Svelte"),
        ("vue", "Vue"),
        ("solid-js", "Solid"),
        ("preact", "Preact"),
        ("@builder.io/qwik", "Qwik"),
        ("react", "React"),
    ]
    .into_iter()
    .find(|(dep, _)| has(pkg, dep))
    .map(|(_, name)| name)?;
    if has(pkg, "vite") || has(pkg, "@sveltejs/kit") {
        return Some((
            framework,
            "Vite",
            first_config(dir, "vite.config"),
            plugins_line("vite"),
        ));
    }
    if has(pkg, "@rsbuild/core") {
        let snippet =
            format!("{IMPORT}\ntools: {{ rspack: {{ plugins: [codeInspectorPlugin({{ bundler: \"rspack\" }})] }} }},");
        return Some((framework, "Rsbuild", first_config(dir, "rsbuild.config"), snippet));
    }
    if has(pkg, "@rspack/core") || has(pkg, "@rspack/cli") {
        return Some((
            framework,
            "Rspack",
            first_config(dir, "rspack.config"),
            plugins_line("rspack"),
        ));
    }
    if has(pkg, "webpack") {
        return Some((
            framework,
            "webpack",
            first_config(dir, "webpack.config"),
            plugins_line("webpack"),
        ));
    }
    None
}

fn install(dir: &Path, root: &Path) -> String {
    let lock = dir.ancestors().take_while(|d| d.starts_with(root)).find_map(|d| {
        [
            ("pnpm-lock.yaml", "pnpm add -D"),
            ("bun.lock", "bun add -d"),
            ("bun.lockb", "bun add -d"),
            ("yarn.lock", "yarn add -D"),
            ("package-lock.json", "npm i -D"),
        ]
        .into_iter()
        .find(|(file, _)| d.join(file).is_file())
        .map(|(_, command)| command)
    });
    let command = format!("{} {PLUGIN}", lock.unwrap_or("npm i -D"));
    match dir.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => format!("cd {} && {command}", rel.display()),
        _ => command,
    }
}

fn packages(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join("package.json").is_file() {
        out.push(dir.to_path_buf());
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !SKIPPED.contains(&name.as_ref())
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        packages(&d, depth - 1, out);
    }
}

pub fn detect(root: &Path) -> Vec<App> {
    let mut found = Vec::new();
    packages(root, DEPTH, &mut found);
    found
        .into_iter()
        .filter_map(|dir| {
            let pkg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
            let (framework, bundler, config, snippet) = kind(&pkg, &dir)?;
            Some(App {
                dir: dir.strip_prefix(root).ok()?.to_string_lossy().into_owned(),
                framework,
                bundler,
                config,
                snippet,
                install: install(&dir, root),
                plugin: has(&pkg, PLUGIN),
                own_lines: framework.starts_with("Svelte"),
            })
        })
        .collect()
}

pub fn app_at(root: &Path, cwd: Option<&Path>) -> Option<App> {
    let root = std::fs::canonicalize(root).ok()?;
    let mut apps = detect(&root);
    let cwd = cwd.and_then(|c| std::fs::canonicalize(c).ok());
    let deepest = cwd.and_then(|cwd| {
        apps.iter()
            .filter(|app| cwd.starts_with(root.join(&app.dir)))
            .max_by_key(|app| app.dir.len())
            .cloned()
    });
    deepest.or_else(|| (apps.len() == 1).then(|| apps.remove(0)))
}

#[tauri::command(async)]
pub fn web_setup(root: String) -> Vec<App> {
    detect(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn scratch(files: &[(&str, &str)]) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("tori-web-setup-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (path, text) in files {
            let at = root.join(path);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, text).unwrap();
        }
        root
    }

    fn one(files: &[(&str, &str)]) -> App {
        let apps = detect(&scratch(files));
        assert_eq!(apps.len(), 1, "{apps:?}");
        apps.into_iter().next().unwrap()
    }

    #[test]
    fn a_vite_react_app_gets_the_vite_plugin_line_and_its_package_manager() {
        let app = one(&[
            (
                "package.json",
                r#"{"dependencies":{"react":"^19"},"devDependencies":{"vite":"^8"}}"#,
            ),
            ("vite.config.js", ""),
            ("pnpm-lock.yaml", ""),
        ]);
        assert_eq!((app.dir.as_str(), app.framework, app.bundler), ("", "React", "Vite"));
        assert_eq!(app.config, "vite.config.js");
        assert!(app
            .snippet
            .ends_with("plugins: [codeInspectorPlugin({ bundler: \"vite\" })],"));
        assert_eq!(app.install, "pnpm add -D code-inspector-plugin");
        assert!(!app.plugin && !app.own_lines);
    }

    #[test]
    fn next_picks_turbopack_from_version_16_or_the_flag_and_webpack_otherwise() {
        let turbo = one(&[("package.json", r#"{"dependencies":{"next":"16.4.2","react":"19"}}"#)]);
        assert_eq!((turbo.framework, turbo.bundler), ("Next", "Turbopack"));
        assert!(turbo
            .snippet
            .contains("turbopack: { rules: codeInspectorPlugin({ bundler: \"turbopack\" }) }"));
        let flag = one(&[(
            "package.json",
            r#"{"scripts":{"dev":"next dev --turbopack"},"dependencies":{"next":"^15.3.0"}}"#,
        )]);
        assert_eq!(flag.bundler, "Turbopack");
        let webpack = one(&[
            ("package.json", r#"{"dependencies":{"next":"^14.2.0"}}"#),
            ("next.config.mjs", ""),
        ]);
        assert_eq!(
            (webpack.bundler, webpack.config.as_str()),
            ("webpack", "next.config.mjs")
        );
        assert!(webpack
            .snippet
            .contains("config.plugins.push(codeInspectorPlugin({ bundler: \"webpack\" }))"));
        let forced = one(&[(
            "package.json",
            r#"{"scripts":{"dev":"next dev --webpack"},"dependencies":{"next":"16"}}"#,
        )]);
        assert_eq!(forced.bundler, "webpack");
    }

    #[test]
    fn nuxt_goes_under_vite_in_its_config() {
        let app = one(&[("package.json", r#"{"devDependencies":{"nuxt":"^4","vue":"^3"}}"#)]);
        assert_eq!(
            (app.framework, app.bundler, app.config.as_str()),
            ("Nuxt", "Vite", "nuxt.config.ts")
        );
        assert!(app
            .snippet
            .contains("vite: { plugins: [codeInspectorPlugin({ bundler: \"vite\" })] }"));
        assert_eq!(app.install, "npm i -D code-inspector-plugin");
    }

    #[test]
    fn a_monorepo_lists_each_app_and_finds_the_one_a_server_runs_in() {
        let root = scratch(&[
            ("package.json", r#"{"private":true,"devDependencies":{"turbo":"^2"}}"#),
            ("pnpm-lock.yaml", ""),
            (
                "apps/web/package.json",
                r#"{"dependencies":{"react":"^19","vite":"^8","code-inspector-plugin":"^2"}}"#,
            ),
            (
                "apps/admin/package.json",
                r#"{"dependencies":{"svelte":"^5"},"devDependencies":{"vite":"^8"}}"#,
            ),
            (
                "apps/web/node_modules/x/package.json",
                r#"{"dependencies":{"react":"1","vite":"1"}}"#,
            ),
            ("apps/web/src/main.tsx", ""),
        ]);
        let apps = detect(&root);
        assert_eq!(
            apps.iter().map(|a| (a.dir.as_str(), a.framework)).collect::<Vec<_>>(),
            [("apps/admin", "Svelte"), ("apps/web", "React")]
        );
        assert!(apps[0].own_lines && !apps[0].plugin);
        assert!(apps[1].plugin);
        assert_eq!(apps[0].install, "cd apps/admin && pnpm add -D code-inspector-plugin");
        let served = app_at(&root, Some(&root.join("apps/web/src"))).unwrap();
        assert_eq!(served.dir, "apps/web");
        assert_eq!(app_at(&root, Some(&root)), None);
        assert_eq!(app_at(&root, None), None);
    }

    #[test]
    fn a_package_with_no_known_framework_and_bundler_is_left_out() {
        assert!(detect(&scratch(&[("package.json", r#"{"dependencies":{"express":"^5"}}"#)])).is_empty());
        assert!(detect(&scratch(&[("package.json", r#"{"dependencies":{"react":"^19"}}"#)])).is_empty());
        assert!(detect(&scratch(&[("Cargo.toml", "")])).is_empty());
    }
}
