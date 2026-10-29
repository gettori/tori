// Read aloud and dictation run on ONNX Runtime, which has no build for Intel
// Macs. Tauri names the target when it runs the frontend build.
export const LOCAL_SPEECH = import.meta.env.TAURI_ENV_ARCH !== "x86_64";
