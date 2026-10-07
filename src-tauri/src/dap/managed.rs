// Debuggers Tori installs itself, for `[install] kind = "pip"`. Each is a venv
// in `~/.config/tori/debuggers/<id>/`, made with the Python on the login PATH
// and holding one exact version of its package. Only the adapter runs from it:
// the program being debugged runs on the project's own interpreter.
//
// The staging, the manifest and the swap are the language servers' own
// (`lsp::managed`), so a failed install leaves the previous one, or nothing.

use std::env::consts::EXE_SUFFIX;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::lsp::managed::{install_staged, last_line, Installed};
use crate::platform::shell;

use super::registry::{DapAdapter, Install};

/// Where Tori's own debuggers live, one directory per adapter id.
pub fn debuggers_dir() -> PathBuf {
    crate::owned_state::config_dir().join("debuggers")
}

/// Install (or replace) Tori's copy of `adapter`.
pub fn install(adapter: &DapAdapter, dir: &Path) -> Result<Installed, String> {
    let python = crate::env::resolve_python().ok_or_else(|| format!("{} was not found on your PATH", shell::PYTHON))?;
    install_with(adapter, dir, &python)
}

fn install_with(adapter: &DapAdapter, dir: &Path, python: &Path) -> Result<Installed, String> {
    let Some(Install::Pip { package, version }) = &adapter.install else {
        return Err(format!("{}: Tori has nothing to install", adapter.id));
    };
    install_staged(dir, &adapter.id, |staging| {
        // A venv keeps working when its directory is renamed, as long as it is
        // run as `venv/bin/python -m ...`: only its console scripts carry the
        // staging path in their shebangs.
        let venv = staging.join("venv");
        run(
            crate::platform::process::command(python)
                .arg("-m")
                .arg("venv")
                .arg(&venv),
            "python -m venv",
        )?;
        // Wheels only: building an sdist runs its setup code, the pip twin of
        // the npm install's `--ignore-scripts`.
        let spec = format!("{package}=={version}");
        run(
            crate::platform::process::command(venv.join(shell::VENV_BIN).join(format!("python{EXE_SUFFIX}")))
                .args([
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-input",
                    "--only-binary=:all:",
                ])
                .arg(&spec),
            &format!("pip install {spec}"),
        )?;
        Ok(Installed {
            version: version.clone(),
            bin: format!("venv/{}/{}{EXE_SUFFIX}", shell::VENV_BIN, adapter.launch.program()),
        })
    })
}

fn run(cmd: &mut Command, what: &str) -> Result<(), String> {
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run {what}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{what} failed: {}", last_line(&out.stderr)))
    }
}

/// The version of `package` for `python`, once `module` imports there, or
/// `None` when it does not: the interpreter fails, the package is missing, or
/// the module is broken.
pub fn package_version(python: &Path, package: &str, module: &str) -> Option<String> {
    let out = crate::env::output_with_timeout(crate::platform::process::command(python).args([
        "-c",
        "import importlib, importlib.metadata, sys; importlib.import_module(sys.argv[2]); \
         print(importlib.metadata.version(sys.argv[1]))",
        package,
        module,
    ]))?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !version.is_empty()).then_some(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dap::registry;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tori_dap_managed_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[ignore = "installs debugpy from PyPI"]
    fn a_pip_install_builds_a_venv_that_runs_the_pinned_package_with_either_python() {
        let adapter = registry::find("debugpy").expect("debugpy is registered");
        for python in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            if !Path::new(python).exists() {
                eprintln!("skipping {python}: not on this machine");
                continue;
            }
            let dir = temp_dir("pip");
            let installed = install_with(adapter, &dir, Path::new(python)).unwrap_or_else(|e| panic!("{python}: {e}"));

            let (bin, manifest) = crate::lsp::managed::installed(&dir, "debugpy").expect("the manifest is written");
            assert_eq!(manifest, installed);
            let version = package_version(&bin, "debugpy", adapter.launch.module().unwrap());
            assert_eq!(version.as_deref(), Some(installed.version.as_str()), "{python}");
            let left: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|e| e.file_name())
                .collect();
            assert_eq!(left, ["debugpy"], "{python}: only the install is left");

            crate::lsp::managed::remove(&dir, "debugpy").unwrap();
            assert!(!dir.join("debugpy").exists());
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
