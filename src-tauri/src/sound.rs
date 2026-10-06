// The sounds Tori plays itself, apart from the OS notification: macOS decides
// whether a notification shows, and these play whatever it decides.

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sound {
    NeedsYou,
    TurnFinished,
}

/// Play one of Tori's sounds. Silent when its file is not there.
pub fn play(app: &AppHandle, sound: Sound) {
    // `PlaySoundW` plays wav only.
    let file = match (sound, cfg!(windows)) {
        (Sound::NeedsYou, false) => "resources/sounds/needs-you.mp3",
        (Sound::NeedsYou, true) => "resources/sounds/needs-you.wav",
        (Sound::TurnFinished, false) => "resources/sounds/turn-finished.mp3",
        (Sound::TurnFinished, true) => "resources/sounds/turn-finished.wav",
    };
    let _ = crate::platform::native::play_sound(app, file);
}

/// Play a sound because the user asked to hear it, from its row in Settings.
#[tauri::command]
pub fn sound_preview(app: AppHandle, sound: Sound) {
    play(&app, sound);
}
