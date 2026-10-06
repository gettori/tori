//! Private files, links, and path strings.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Creates `dir` and its parents, entered only by this user: `0700` on Unix, and
/// on Windows a protected DACL granting the user and SYSTEM alone, which what
/// is created inside inherits.
pub fn private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    restrict_to_user(dir)?;
    Ok(())
}

#[cfg(windows)]
fn restrict_to_user(dir: &Path) -> io::Result<()> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: every buffer outlives the call that reads it, and every handle and
    // allocation made here is closed or freed before returning.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let got = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        got?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);

        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid)?;
        let sddl = format!(
            "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{})",
            sid.to_string().unwrap_or_default()
        );
        let _ = LocalFree(Some(HLOCAL(sid.0.cast())));

        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(sddl),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )?;
        let mut present = false.into();
        let mut defaulted = false.into();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let read = GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted);
        let set = read.map(|()| {
            SetNamedSecurityInfoW(
                &HSTRING::from(dir.as_os_str()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl),
                None,
            )
        });
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        let code = set?;
        if code.is_err() {
            return Err(io::Error::from_raw_os_error(code.0 as i32));
        }
        Ok(())
    }
}

/// A new file readable only by this user from the moment it exists: created
/// `0600` on Unix, so its contents are never visible under a wider mode.
pub fn create_private(path: &Path) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Replaces `path` with `contents`, private as [`create_private`] makes it.
pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let _ = std::fs::remove_file(path);
    create_private(path)?.write_all(contents)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Symlink,
    Junction,
    Hardlink,
}

/// Puts a link to `target` at `link`. Windows refuses symlinks without
/// Developer Mode or elevation, so there a directory falls back to a junction
/// and a file to a hardlink. Neither needs a privilege, and both read through
/// to `target` as a symlink would.
pub fn link_entry(target: &Path, link: &Path) -> io::Result<LinkKind> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)?;
        Ok(LinkKind::Symlink)
    }
    #[cfg(windows)]
    {
        const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
        // A relative target means relative to the link, as a symlink reads it.
        // Junctions and hardlinks resolve against the working directory instead.
        let anchored = link
            .parent()
            .map_or_else(|| target.to_path_buf(), |dir| dir.join(target));
        let is_dir = anchored.is_dir();
        let tried = if is_dir {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        match tried {
            Ok(()) => Ok(LinkKind::Symlink),
            Err(e) if e.raw_os_error() != Some(ERROR_PRIVILEGE_NOT_HELD) => Err(e),
            Err(_) if is_dir => junction::create(&anchored, link).map(|()| LinkKind::Junction),
            Err(_) => std::fs::hard_link(&anchored, link).map(|()| LinkKind::Hardlink),
        }
    }
}

/// Removes the link at `link` and never what it points to. A directory
/// symlink or junction on Windows is a directory entry, so it needs
/// `remove_dir`, which also refuses a real directory that is not empty.
pub fn unlink_entry(link: &Path) -> io::Result<()> {
    match std::fs::remove_file(link) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(_)
            if link
                .symlink_metadata()
                .is_ok_and(|m| m.is_dir() || m.file_type().is_symlink()) =>
        {
            std::fs::remove_dir(link)
        }
        Err(e) => Err(e),
    }
}

/// Is the entry at `link` a link (any [`LinkKind`]) that reaches `target`?
pub fn is_link_into(link: &Path, target: &Path) -> bool {
    let Ok(meta) = link.symlink_metadata() else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return matches!((canonical(link), canonical(target)), (Ok(a), Ok(b)) if a == b);
    }
    #[cfg(windows)]
    if junction::exists(link).unwrap_or(false) {
        return matches!((canonical(link), canonical(target)), (Ok(a), Ok(b)) if a == b);
    }
    #[cfg(windows)]
    if meta.is_file() && link != target {
        return same_file(link, target);
    }
    false
}

/// Are `a` and `b` one file, by identity rather than by path, so a hardlink and
/// its target count as one?
pub fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(windows)]
    {
        same_file::is_same_file(a, b).unwrap_or(false)
    }
}

/// The one spelling of `path` used as a key: symlinks resolved, no `\\?\`
/// prefix, and the drive letter upper case, since `c:/x` and `C:/x` name the
/// same folder.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    let resolved = dunce::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = resolved.to_string_lossy();
        let mut chars = text.chars();
        if let (Some(drive), Some(':')) = (chars.next(), chars.next()) {
            if drive.is_ascii_lowercase() {
                return Ok(PathBuf::from(format!("{}{}", drive.to_ascii_uppercase(), &text[1..])));
            }
        }
    }
    Ok(resolved)
}

/// `path` as the backend emits it: forward slashes on every OS, as git prints
/// paths on Windows too.
pub fn display(path: &Path) -> String {
    #[cfg(unix)]
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    let text = path.to_string_lossy().replace('\\', "/");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-platform-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_private_file_is_private_from_creation() {
        let dir = scratch("private");
        let file = dir.join("secret");
        write_private(&file, b"one").unwrap();
        write_private(&file, b"two").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        crate::platform::testing::assert_private(&file);
        private_dir(&dir.join("inner")).unwrap();
        crate::platform::testing::assert_private(&dir.join("inner"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_linked_dir_reads_through_and_unlinks_without_touching_its_target() {
        let dir = scratch("link-dir");
        let target = dir.join("shared");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("f"), "x").unwrap();
        let link = dir.join("wt-shared");
        link_entry(&target, &link).unwrap();
        assert_eq!(std::fs::read_to_string(link.join("f")).unwrap(), "x");
        assert!(is_link_into(&link, &target));
        assert!(!is_link_into(&target, &target));
        unlink_entry(&link).unwrap();
        assert!(link.symlink_metadata().is_err());
        assert!(target.join("f").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_linked_file_reads_through_and_unlinks_without_touching_its_target() {
        let dir = scratch("link-file");
        let target = dir.join(".env");
        std::fs::write(&target, "KEY=1").unwrap();
        let link = dir.join("wt-env");
        link_entry(&target, &link).unwrap();
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "KEY=1");
        assert!(is_link_into(&link, &target));
        unlink_entry(&link).unwrap();
        assert!(target.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unlink_refuses_a_real_directory_with_contents() {
        let dir = scratch("unlink-real");
        std::fs::write(dir.join("f"), "x").unwrap();
        assert!(unlink_entry(&dir).is_err());
        assert!(dir.join("f").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn canonical_resolves_a_link_to_its_target() {
        let dir = scratch("canonical");
        let target = dir.join("real");
        std::fs::create_dir_all(&target).unwrap();
        let link = dir.join("alias");
        link_entry(&target, &link).unwrap();
        assert_eq!(canonical(&link).unwrap(), canonical(&target).unwrap());
        assert!(!display(&canonical(&target).unwrap()).contains('\\'));
        std::fs::remove_dir_all(&dir).ok();
    }
}
