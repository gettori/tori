//! The paths behind a drop from another app.
//!
//! The webview is handed `File` objects whose paths WebKit withholds, so a drop
//! that should become a copy has nothing to copy *from*. The drag pasteboard
//! does: the source app wrote the file URLs there to start the drag, it is
//! process-wide, and its contents outlive the session, so reading it as the drop
//! lands answers for that drag.

/// Absolute paths the drag being let go of is holding, and empty when it holds
/// no files (a promised file, an image dragged off a web page).
// `NSFilenamesPboardType` is deprecated in favour of per-item file URLs, and is
// what wry's own file drop reads: AppKit synthesises it for any file drag, and a
// flat list of paths is the whole answer here.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
#[tauri::command(async)]
pub fn drag_paths(nonce: Option<String>) -> Vec<String> {
    let _ = nonce;
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSString};

    let mut paths = Vec::new();
    unsafe {
        let board = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        let wanted = NSArray::arrayWithObject(NSFilenamesPboardType);
        if board.availableTypeFromArray(&wanted).is_none() {
            return paths;
        }
        let Some(list) = board.propertyListForType(NSFilenamesPboardType) else {
            return paths;
        };
        let Ok(list) = list.downcast::<NSArray>() else {
            return paths;
        };
        for item in list {
            if let Ok(path) = item.downcast::<NSString>() {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

// The paths the page posted under `nonce` with the drop's files, waited for
// because the message and this call reach the host by separate routes.
#[cfg(windows)]
#[tauri::command(async)]
pub fn drag_paths(nonce: Option<String>) -> Vec<String> {
    use std::time::{Duration, Instant};
    let Some(nonce) = nonce else {
        return Vec::new();
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut drops = DROPS.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if let Some(i) = drops.iter().position(|(n, _)| *n == nonce) {
            return drops.swap_remove(i).1;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Vec::new();
        }
        drops = ARRIVED.wait_timeout(drops, left).unwrap_or_else(|e| e.into_inner()).0;
    }
}

#[cfg(windows)]
static DROPS: std::sync::Mutex<Vec<(String, Vec<String>)>> = std::sync::Mutex::new(Vec::new());
#[cfg(windows)]
static ARRIVED: std::sync::Condvar = std::sync::Condvar::new();

/// Takes the drops the page posts as `{ toriDrop: nonce }` with their `File`
/// objects attached, which is how WebView2 lets the host see a dropped file's
/// path. A message posted as JSON rather than a string is one wry's own
/// handler skips.
#[cfg(windows)]
pub fn listen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows::core::{Interface, PWSTR};

    window.with_webview(|webview| {
        let handler = WebMessageReceivedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut json = PWSTR::null();
            // SAFETY: WebView2 COM calls on live interfaces, each out-pointer a
            // local that `take_pwstr` frees.
            unsafe { args.WebMessageAsJson(&mut json)? };
            let message: serde_json::Value = serde_json::from_str(&take_pwstr(json)).unwrap_or_default();
            let Some(nonce) = message.get("toriDrop").and_then(|n| n.as_str()) else {
                return Ok(());
            };
            let mut paths = Vec::new();
            unsafe {
                let objects = args
                    .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
                    .AdditionalObjects()?;
                let mut count = 0;
                objects.Count(&mut count)?;
                for i in 0..count {
                    let Ok(file) = objects.GetValueAtIndex(i).and_then(|o| o.cast::<ICoreWebView2File>()) else {
                        continue;
                    };
                    let mut path = PWSTR::null();
                    if file.Path(&mut path).is_ok() {
                        paths.push(crate::platform::fs::display(take_pwstr(path)));
                    }
                }
            }
            let mut drops = DROPS.lock().unwrap_or_else(|e| e.into_inner());
            // A drop nobody asked for in time is never asked for.
            if drops.len() >= 8 {
                drops.remove(0);
            }
            drops.push((nonce.to_string(), paths));
            ARRIVED.notify_all();
            Ok(())
        }));
        let mut token = 0;
        // SAFETY: as above; the handler lives as long as the webview holds it.
        unsafe {
            if let Ok(core) = webview.controller().CoreWebView2() {
                let _ = core.add_WebMessageReceived(&handler, &mut token);
            }
        }
    })
}

#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn drag_paths(nonce: Option<String>) -> Vec<String> {
    let _ = nonce;
    Vec::new()
}
