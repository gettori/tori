// The sounds Tori plays itself, apart from the OS notification: macOS decides
// whether a notification shows, and these play whatever it decides.

use tauri::AppHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sound {
    NeedsYou,
    TurnFinished,
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::OnceCell;

    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;
    use tauri::path::BaseDirectory;
    use tauri::{AppHandle, Manager};

    use super::Sound;

    // NSSound is neither Send nor Sync, so each one stays on the main thread
    // that loaded it. A missing file is remembered too, and said once.
    thread_local! {
        static NEEDS_YOU: OnceCell<Option<Retained<NSSound>>> = const { OnceCell::new() };
        static TURN_FINISHED: OnceCell<Option<Retained<NSSound>>> = const { OnceCell::new() };
    }

    fn load(app: &AppHandle, file: &str) -> Option<Retained<NSSound>> {
        let path = app.path().resolve(file, BaseDirectory::Resource).ok().filter(|p| p.exists());
        let sound = path.and_then(|p| {
            NSSound::initWithContentsOfFile_byReference(NSSound::alloc(), &NSString::from_str(&p.to_string_lossy()), true)
        });
        if sound.is_none() {
            eprintln!("tori: no sound to play at {file}");
        }
        sound
    }

    pub fn play(app: &AppHandle, sound: Sound) {
        let (slot, file) = match sound {
            Sound::NeedsYou => (&NEEDS_YOU, "resources/sounds/needs-you.mp3"),
            Sound::TurnFinished => (&TURN_FINISHED, "resources/sounds/turn-finished.mp3"),
        };
        slot.with(|cell| {
            if let Some(loaded) = cell.get_or_init(|| load(app, file)) {
                loaded.play();
            }
        });
    }
}

/// Play one of Tori's sounds. Silent elsewhere than macOS, and when its file
/// is not there.
pub fn play(app: &AppHandle, sound: Sound) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || mac::play(&handle, sound));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, sound);
}
