// Cargo for the Rust debug targets. `dap.rs` puts every call behind the trust
// gate: cargo runs build scripts and proc macros, and a `rust-toolchain.toml`
// decides which cargo runs at all.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use serde_json::Value;

/// What a cancelled build rejects with, so the editor says nothing about it.
pub const CANCELLED: &str = "cancelled";

static BUILDS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub executable: String,
    /// The toolchain's sysroot, where Rust's lldb formatters live. `None` when
    /// `rustc` would not say, and then values show as raw structs.
    pub sysroot: Option<String>,
}

fn tool(program: &str, root: &Path) -> Command {
    let mut cmd = Command::new(crate::env::resolve_binary(program).unwrap_or_else(|| program.into()));
    cmd.current_dir(root).env("PATH", crate::env::augmented_path()).stdin(Stdio::null());
    cmd
}

/// The `bin` targets of the package whose manifest is `manifest`, in the order
/// `cargo metadata` lists them. Empty for a manifest with no package, like a
/// virtual workspace root.
pub fn bins_in(metadata: &str, manifest: &Path) -> Result<Vec<String>, String> {
    let meta: Value = serde_json::from_str(metadata).map_err(|e| format!("cargo metadata: {e}"))?;
    let package = meta["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["manifest_path"].as_str().map(Path::new) == Some(manifest));
    let targets = package.and_then(|p| p["targets"].as_array()).into_iter().flatten();
    Ok(targets
        .filter(|t| t["kind"].as_array().is_some_and(|kinds| kinds.iter().any(|k| k == "bin")))
        .filter_map(|t| t["name"].as_str().map(str::to_string))
        .collect())
}

/// The binaries of the package at `root`.
pub fn bins(root: &Path) -> Result<Vec<String>, String> {
    let out = tool("cargo", root)
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .output()
        .map_err(|e| format!("could not run cargo: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(first_error(stderr.lines()).unwrap_or_else(|| "cargo metadata failed".into()));
    }
    // cargo reports the physical path, and a temp dir or a project under a
    // symlink would otherwise never match.
    let manifest = std::fs::canonicalize(root.join("Cargo.toml")).map_err(|e| e.to_string())?;
    bins_in(&String::from_utf8_lossy(&out.stdout), &manifest)
}

fn first_error<'a>(mut lines: impl Iterator<Item = &'a str>) -> Option<String> {
    let error = lines.find(|l| l.starts_with("error"))?.to_string();
    Some(match lines.next().map(str::trim_start) {
        Some(at) if at.starts_with("-->") => format!("{error} {at}"),
        _ => error,
    })
}

/// Build `bin` at `root`, handing every line cargo writes for people (progress
/// and rendered diagnostics) to `on_line`. Resolves to the executable from the
/// `compiler-artifact` message, or to the first error.
pub fn build(root: &Path, bin: &str, id: &str, mut on_line: impl FnMut(&str)) -> Result<Built, String> {
    let mut child = tool("cargo", root)
        .args(["build", "--bin", bin, "--message-format=json-render-diagnostics"])
        // Its own group, so a cancel takes rustc and build scripts with it.
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run cargo: {e}"))?;
    BUILDS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(id.into(), child.id());

    let stdout = child.stdout.take().ok_or("cargo has no stdout")?;
    let name = bin.to_string();
    let messages = thread::spawn(move || executable_in(stdout, &name));
    let stderr = child.stderr.take().ok_or("cargo has no stderr")?;
    let mut printed = Vec::new();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        on_line(&line);
        printed.push(line);
    }
    let status = child.wait().map_err(|e| e.to_string());
    let cancelled = BUILDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .is_none_or(|builds| builds.remove(id).is_none());
    let executable = messages.join().unwrap_or(None);

    if cancelled {
        return Err(CANCELLED.into());
    }
    match (status?.success(), executable) {
        (true, Some(executable)) => Ok(Built { executable, sysroot: sysroot(root) }),
        (true, None) => Err(format!("cargo built `{bin}` but named no executable for it")),
        (false, _) => Err(first_error(printed.iter().map(String::as_str))
            .unwrap_or_else(|| format!("cargo could not build `{bin}`"))),
    }
}

fn executable_in(stdout: impl Read, name: &str) -> Option<String> {
    BufReader::new(stdout).lines().map_while(Result::ok).fold(None, |found, line| {
        let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        let is_bin = msg["target"]["kind"].as_array().is_some_and(|k| k.iter().any(|k| k == "bin"));
        if msg["reason"] == "compiler-artifact" && is_bin && msg["target"]["name"] == name {
            msg["executable"].as_str().map(str::to_string).or(found)
        } else {
            found
        }
    })
}

fn sysroot(root: &Path) -> Option<String> {
    let out = tool("rustc", root).args(["--print", "sysroot"]).output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !path.is_empty()).then_some(path)
}

/// Stop the build the editor started as `id`, if it is still running.
pub fn cancel(id: &str) {
    let pid = BUILDS.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|b| b.remove(id));
    if let Some(pid) = pid {
        // The negative pid is the group, as `dap::stop` kills an adapter's.
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{pid}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A workspace of two packages, trimmed to the fields `bins_in` reads.
    const METADATA: &str = r#"{
        "packages": [
            { "name": "app", "manifest_path": "/w/app/Cargo.toml", "targets": [
                { "kind": ["lib"], "name": "app" },
                { "kind": ["bin"], "name": "app" },
                { "kind": ["bin"], "name": "migrate" },
                { "kind": ["test"], "name": "smoke" }
            ] },
            { "name": "cli", "manifest_path": "/w/cli/Cargo.toml", "targets": [
                { "kind": ["bin"], "name": "cli" }
            ] }
        ],
        "workspace_root": "/w"
    }"#;

    #[test]
    fn lists_the_bins_of_the_package_at_the_root_and_no_others() {
        assert_eq!(bins_in(METADATA, Path::new("/w/app/Cargo.toml")).unwrap(), ["app", "migrate"]);
        assert_eq!(bins_in(METADATA, Path::new("/w/cli/Cargo.toml")).unwrap(), ["cli"]);
        // The virtual workspace manifest has no package, so no binaries.
        assert!(bins_in(METADATA, Path::new("/w/Cargo.toml")).unwrap().is_empty());
    }

    #[test]
    fn a_type_error_fails_the_build_with_the_first_error_and_where_it_is() {
        if crate::env::resolve_binary("cargo").is_none() {
            eprintln!("skipping: cargo is not on your login PATH");
            return;
        }
        let dir = std::env::temp_dir().join(format!("tori-cargo-{}-{}", std::process::id(), crate::dap::next_id("t")));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"broken\"\nversion = \"0.1.0\"\nedition = \"2021\"\n").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {\n    let n: u32 = \"three\";\n    println!(\"{n}\");\n}\n").unwrap();

        let mut printed = Vec::new();
        let result = build(&dir, "broken", &crate::dap::next_id("b"), |line| printed.push(line.to_string()));
        std::fs::remove_dir_all(&dir).ok();

        let error = result.expect_err("the build fails");
        assert!(error.starts_with("error[E0308]"), "{error}");
        assert!(error.contains("--> src/main.rs:2"), "{error}");
        assert!(printed.iter().any(|l| l.contains("Compiling broken")), "{printed:?}");
    }
}
