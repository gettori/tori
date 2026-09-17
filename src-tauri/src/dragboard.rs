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
pub fn drag_paths() -> Vec<String> {
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

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub fn drag_paths() -> Vec<String> {
    Vec::new()
}
