//! The desktop around the window: pickers, the file manager, sounds, sleep.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

// Both pickers block until the user picks or cancels, so call them off the main
// thread (an async command).
pub fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title(title)
        .blocking_pick_folder()?
        .into_path()
        .ok()
}

pub fn pick_file(app: &AppHandle, title: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title(title)
        .blocking_pick_file()?
        .into_path()
        .ok()
}

pub fn reveal(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

pub fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Opens `path` with its default program: an app bundle or an exe launches.
pub fn open_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn os_version() -> String {
    let version = sysinfo::System::long_os_version().unwrap_or_else(|| "unknown".into());
    format!("{version} {}", std::env::consts::ARCH)
}

pub fn credential_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, String> {
    #[cfg(target_os = "macos")]
    {
        let store =
            apple_native_keyring_store::keychain::Store::new().map_err(|e| format!("keychain unavailable: {e}"))?;
        Ok(store)
    }
    #[cfg(windows)]
    {
        let store =
            windows_native_keyring_store::Store::new().map_err(|e| format!("Credential Manager unavailable: {e}"))?;
        Ok(store)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("no credential store on Linux yet (#21)".into())
}

#[cfg(target_os = "macos")]
mod mac_sound {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;
    use tauri::path::BaseDirectory;
    use tauri::{AppHandle, Manager};

    // NSSound is neither Send nor Sync, so each one stays on the main thread
    // that loaded it. A missing file is remembered too, and said once.
    thread_local! {
        static LOADED: RefCell<HashMap<&'static str, Option<Retained<NSSound>>>> = RefCell::new(HashMap::new());
    }

    fn load(app: &AppHandle, file: &str) -> Option<Retained<NSSound>> {
        let path = app
            .path()
            .resolve(file, BaseDirectory::Resource)
            .ok()
            .filter(|p| p.exists());
        let sound = path.and_then(|p| {
            NSSound::initWithContentsOfFile_byReference(
                NSSound::alloc(),
                &NSString::from_str(&p.to_string_lossy()),
                true,
            )
        });
        if sound.is_none() {
            eprintln!("tori: no sound to play at {file}");
        }
        sound
    }

    pub fn play(app: &AppHandle, file: &'static str) {
        LOADED.with(|loaded| {
            let mut loaded = loaded.borrow_mut();
            if let Some(sound) = loaded.entry(file).or_insert_with(|| load(app, file)) {
                sound.play();
            }
        });
    }
}

pub fn play_sound(app: &AppHandle, file: &'static str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || mac_sound::play(&handle, file))
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use tauri::path::BaseDirectory;
        use tauri::Manager;
        use windows::core::HSTRING;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
        let path = app
            .path()
            .resolve(file, BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        if !path.exists() {
            return Ok(());
        }
        // SAFETY: PlaySoundW copies the path before it returns, even with SND_ASYNC.
        let played = unsafe {
            PlaySoundW(
                &HSTRING::from(path.as_os_str()),
                None,
                SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
            )
        };
        played
            .as_bool()
            .then_some(())
            .ok_or_else(|| format!("could not play {file}"))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (app, file);
        Err("sounds are not supported on Linux yet (#21)".into())
    }
}

// Keeps the machine from idle sleeping while held, since a sleeping machine
// drops every phone on the remote front. A closed lid on battery still sleeps.
// The OS drops the hold with the process, so a crash cannot leak it.
pub struct KeepAwake {
    #[cfg(target_os = "macos")]
    id: u32,
    #[cfg(windows)]
    request: windows::Win32::Foundation::HANDLE,
}

// SAFETY: the power request handle is owned by this value alone, and power
// request calls are not tied to the thread that made them.
#[cfg(windows)]
unsafe impl Send for KeepAwake {}
#[cfg(windows)]
unsafe impl Sync for KeepAwake {}

#[cfg(target_os = "macos")]
mod mac_awake {
    use std::ffi::{c_char, c_void, CString};

    pub type CFStringRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, text: *const c_char, encoding: u32) -> CFStringRef;
        pub fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        pub fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        pub fn IOPMAssertionRelease(id: u32) -> i32;
    }

    const UTF8: u32 = 0x0800_0100;
    pub const LEVEL_ON: u32 = 255;

    pub fn cf_string(text: &str) -> Option<CFStringRef> {
        let text = CString::new(text).ok()?;
        let cf = unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) };
        (!cf.is_null()).then_some(cf)
    }
}

impl KeepAwake {
    #[cfg(target_os = "macos")]
    pub fn hold(reason: &str) -> Result<Self, String> {
        use mac_awake::*;
        let refused = || "the system refused to stay awake".to_string();
        let kind = cf_string("PreventUserIdleSystemSleep").ok_or_else(refused)?;
        let Some(name) = cf_string(reason) else {
            unsafe { CFRelease(kind) };
            return Err(refused());
        };
        let mut id = 0;
        let status = unsafe { IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) };
        unsafe {
            CFRelease(kind);
            CFRelease(name);
        }
        (status == 0).then_some(Self { id }).ok_or_else(refused)
    }

    #[cfg(windows)]
    pub fn hold(reason: &str) -> Result<Self, String> {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Power::{PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest};
        use windows::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
        use windows::Win32::System::Threading::{
            POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
        };
        let mut text: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        let context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: PWSTR(text.as_mut_ptr()),
            },
        };
        // SAFETY: `context` and the string it points at outlive both calls, and
        // the handle is closed on failure or owned by the returned value.
        unsafe {
            let request = PowerCreateRequest(&context).map_err(|e| e.to_string())?;
            if let Err(e) = PowerSetRequest(request, PowerRequestSystemRequired) {
                let _ = CloseHandle(request);
                return Err(e.to_string());
            }
            Ok(Self { request })
        }
    }

    #[cfg(target_os = "linux")]
    pub fn hold(_reason: &str) -> Result<Self, String> {
        Err("keeping the machine awake is not supported on Linux yet (#21)".into())
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            mac_awake::IOPMAssertionRelease(self.id);
        }
        #[cfg(windows)]
        // SAFETY: releasing and closing the handle this value owns.
        unsafe {
            use windows::Win32::System::Power::{PowerClearRequest, PowerRequestSystemRequired};
            let _ = PowerClearRequest(self.request, PowerRequestSystemRequired);
            let _ = windows::Win32::Foundation::CloseHandle(self.request);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_version_names_the_architecture() {
        assert!(os_version().ends_with(std::env::consts::ARCH));
    }
}
