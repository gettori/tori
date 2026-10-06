const os = navigator.platform.startsWith("Mac") ? "mac" : navigator.platform.startsWith("Win") ? "windows" : "linux";

export const isMac = os === "mac";
export const isWindows = os === "windows";

export const OS_NAME = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
export const FILE_MANAGER = isMac ? "Finder" : isWindows ? "File Explorer" : "File Manager";
export const THIS_MACHINE = isMac ? "this Mac" : "this computer";
export const TRASH = isWindows ? "Recycle Bin" : "Trash";
