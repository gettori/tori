// Project icons. A project row in the sidebar shows, in order: an image the
// user uploaded, a Lucide glyph the user picked, the icon found in the project
// itself, and finally a deterministic glyph the frontend derives from the path.
// This module owns the two halves that need the filesystem - finding a
// project's own icon, and copying an uploaded image into a store the config can
// point at. The chosen-icon *storage* is a `[[project_meta]]` table in
// `sway.toml`, written by config.rs alongside the `[[space]]` overlay.
//
// ---- How detection works, and what it is defending against ----
//
// Not every project is a web app. A Tauri app declares its icon in
// `tauri.conf.json`, an Expo app in `app.json`, an iOS/macOS app in an
// `AppIcon.appiconset`, an Android app in a `mipmap-*` ladder, and a monorepo
// keeps all of it one directory further down. A single ordered list of
// "look here, then here" cannot express that, and worse, the first thing it
// finds is not usually the best thing available.
//
// The failure that actually matters is not "found nothing" - a project with no
// icon gets a derived glyph, which is unique and therefore useful. It is
// "confidently wrong": a scaffolded app ships `vite.svg`, so a naive scan makes
// a dozen unrelated projects show the same framework logo, destroying the one
// job the icon has. So detection is built to be wrong rarely rather than to hit
// often, along four lines:
//
//   1. DECLARED BEATS GUESSED. A manifest is the project telling us its icon.
//      Every manifest is read from an ANCHORED path, never found by filename:
//      a real tree here contains `.obsidian/app.json` and `core/manifest.json`,
//      neither of which is an Expo or web manifest, and a filename search eats
//      both.
//   2. RANK, DO NOT FIRST-MATCH. Candidates are collected from every resolver
//      and scored, so a declared app icon wins over a stray `logo.svg` as a
//      rule rather than by list order.
//   3. BE DETERMINISTIC. A worktree container is asked about several worktrees;
//      ties break on the path, never on the order git happened to report, so a
//      project's icon cannot change when a worktree is added or removed.
//   4. REFUSE SCAFFOLD ART. A file named for the framework that generated it is
//      not this project's identity, whoever else also has it.
//
// What it deliberately does not do: guarantee correctness. Heuristics cannot.
// It guarantees only that a wrong answer is rare, stable, and one right-click
// away from being overridden.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Image types the webview can render in an `<img>`, and so the only ones worth
/// detecting or accepting. `.icns` is deliberately absent: macOS ships it for
/// app bundles and no browser engine draws it. Android's adaptive-icon XML and
/// VectorDrawables are absent for the same reason.
pub const ICON_EXTS: &[&str] = &["svg", "png", "ico", "webp", "jpg", "jpeg"];

/// What a user may upload. Narrower than what we will *detect*: a photo is
/// never a deliberate icon choice, but a `.jpg` found in a project might be the
/// only mark it has.
pub const UPLOAD_EXTS: &[&str] = &["svg", "png", "ico"];

/// An uploaded icon is a small image, not an asset: the cap exists so a stray
/// pick of a 40 MB PSD-turned-PNG cannot be copied into the config dir.
const MAX_ICON_BYTES: u64 = 2 * 1024 * 1024;

/// Directories never worth descending: build output, dependency trees and
/// caches. Their icons belong to someone else's package.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
    "vendor", "Pods", "DerivedData", ".gradle", ".venv", "venv", "__pycache__", "coverage",
    ".turbo", ".cache", ".output", "Carthage",
];

/// Art that ships with a project generator. Matched on file name because that
/// is what makes it identifiable regardless of the framework's version: nobody
/// names their own product mark `vite.svg`. Note that SIZE is not a signal here
/// and must not become one - a real hand-drawn favicon in this very tree is 299
/// bytes, smaller than most scaffold art.
const SCAFFOLD_NAMES: &[&str] = &[
    "vite.svg",
    "next.svg",
    "vercel.svg",
    "react.svg",
    "tauri.svg",
    "svelte.svg",
    "nuxt.svg",
    "electron.svg",
    "angular.svg",
    "solid.svg",
    "astro.svg",
    "remix.svg",
    "logo192.png",
    "logo512.png",
    "flutter_logo.png",
];

// ---------------------------------------------------------------------------
// Candidates and scoring
// ---------------------------------------------------------------------------

/// How much a candidate's *source* is worth believing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Authority {
    /// Read out of a manifest: the project naming its own icon.
    Declared,
    /// A path an ecosystem reserves for icons (`res/mipmap-*`, `src-tauri/icons`).
    Conventional,
    /// A plausible file in a plausible place. A guess, and scored like one.
    Generic,
}

/// What the file is *for*, which is not the same as how much we trust it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// The application's own mark: a bundle icon, a launcher icon.
    AppIcon,
    /// A browser tab icon. Usually right, occasionally a placeholder.
    Favicon,
    /// Marketing art. Often a wordmark, which reads badly at 16px.
    Logo,
}

#[derive(Clone, Debug)]
struct Candidate {
    path: PathBuf,
    authority: Authority,
    kind: Kind,
    /// True when found below a workspace member rather than at the project root.
    nested: bool,
    /// Where the resolver's own list put it, 0 being first. The weakest signal
    /// there is, used only to break an otherwise exact tie: `icon.png` and
    /// `adaptive-icon.png` sit in the same folder at the same size and are
    /// equally app icons, but the first is the app's mark and the second is one
    /// Android layer of it. Where a list's order carries no preference (a Tauri
    /// bundle array, a manifest's `icons`) every entry is offered at 0.
    rank: usize,
}

/// The largest square dimension a raster declares, or `None` for a vector (which
/// needs no bonus because it is already the best possible answer) and for
/// formats we do not parse.
fn pixels(path: &Path) -> Option<u32> {
    let ext = ext_of(path);
    let head = read_head(path, 32)?;
    match ext.as_str() {
        // PNG: 8-byte signature, 4-byte chunk length, "IHDR", then w/h as BE u32.
        "png" => {
            if head.len() < 24 || &head[0..8] != b"\x89PNG\r\n\x1a\n" {
                return None;
            }
            let w = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
            let h = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
            Some(w.min(h))
        }
        // ICO: the directory entry's width byte, where 0 encodes 256.
        "ico" => {
            if head.len() < 8 {
                return None;
            }
            Some(if head[6] == 0 { 256 } else { head[6] as u32 })
        }
        _ => None,
    }
}

fn read_head(path: &Path, n: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; n];
    let read = f.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(buf)
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// A candidate's total worth. Authority dominates, because a declaration is a
/// different class of evidence from a guess; kind and resolution only order
/// candidates that are already equally trustworthy.
fn score(c: &Candidate) -> i32 {
    let authority = match c.authority {
        Authority::Declared => 300,
        Authority::Conventional => 200,
        Authority::Generic => 100,
    };
    let kind = match c.kind {
        Kind::AppIcon => 30,
        Kind::Favicon => 20,
        Kind::Logo => 10,
    };
    // A vector is resolution-independent, so it beats every raster of the same
    // authority and kind. A raster earns up to 20 for being big enough to look
    // sharp: 1024px maxes out, 128px scores 2, a 16px favicon earns nothing.
    let quality = if ext_of(&c.path) == "svg" {
        25
    } else {
        pixels(&c.path).map(|p| (p / 64).min(20) as i32).unwrap_or(0)
    };
    // A workspace member's icon is real (a monorepo's app lives there) but it is
    // one step removed from "this project's identity", so it loses to anything
    // the root declares about itself.
    let nested = if c.nested { -50 } else { 0 };
    authority + kind + quality + nested
}

/// Is this file scaffold art rather than an identity?
fn is_scaffold(path: &Path) -> bool {
    SCAFFOLD_NAMES.contains(&file_name_of(path).as_str())
}

fn renderable(path: &Path) -> bool {
    ICON_EXTS.contains(&ext_of(path).as_str())
}

/// Record `path` as a candidate when it is a real, renderable, non-scaffold
/// file. Every resolver funnels through here, so those three rules are applied
/// exactly once and cannot be forgotten by a new resolver.
fn offer(out: &mut Vec<Candidate>, path: PathBuf, authority: Authority, kind: Kind, nested: bool) {
    offer_ranked(out, path, authority, kind, nested, 0);
}

/// `offer`, for a resolver whose list order is a genuine preference.
fn offer_ranked(
    out: &mut Vec<Candidate>,
    path: PathBuf,
    authority: Authority,
    kind: Kind,
    nested: bool,
    rank: usize,
) {
    if !path.is_file() || !renderable(&path) || is_scaffold(&path) {
        return;
    }
    out.push(Candidate { path, authority, kind, nested, rank });
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Resolve a manifest-declared path, which may be written with a leading `./`
/// or (in web manifests) as a site-absolute `/icon.png`. A site-absolute path is
/// relative to the manifest's own directory, which for `public/manifest.json`
/// is exactly where `/icon.png` lives on disk.
fn join_declared(base: &Path, declared: &str) -> PathBuf {
    let rel = declared.trim().trim_start_matches("./").trim_start_matches('/');
    base.join(rel)
}

// ---------------------------------------------------------------------------
// Manifest resolvers. Every one is anchored: it reads a specific path, and does
// nothing at all if that path is absent.
// ---------------------------------------------------------------------------

/// Tauri: `src-tauri/tauri.conf.json`, `bundle.icon` (v2) or `tauri.bundle.icon`
/// (v1). Entries are relative to the config's own directory.
fn from_tauri(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    let conf = dir.join("src-tauri/tauri.conf.json");
    let Some(json) = read_json(&conf) else { return };
    let icons = json
        .pointer("/bundle/icon")
        .or_else(|| json.pointer("/tauri/bundle/icon"))
        .and_then(|v| v.as_array());
    let Some(icons) = icons else { return };
    let base = conf.parent().unwrap_or(dir);
    for entry in icons.iter().filter_map(|v| v.as_str()) {
        offer(out, join_declared(base, entry), Authority::Declared, Kind::AppIcon, nested);
    }
}

/// Expo / React Native: `app.json` (or `app.config.json`) at the project root.
/// A JS config (`app.config.ts`) cannot be read, which is why the convention
/// scan below still has to cover `assets/`.
fn from_expo(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    for name in ["app.json", "app.config.json"] {
        let conf = dir.join(name);
        let Some(json) = read_json(&conf) else { continue };
        // Anchored twice over: the file must be at the root AND carry an `expo`
        // key. `.obsidian/app.json` satisfies neither.
        let Some(expo) = json.get("expo") else { continue };
        for ptr in ["/icon", "/ios/icon", "/android/adaptiveIcon/foregroundImage", "/web/favicon"] {
            if let Some(rel) = expo.pointer(ptr).and_then(|v| v.as_str()) {
                let kind = if ptr == "/web/favicon" { Kind::Favicon } else { Kind::AppIcon };
                offer(out, join_declared(dir, rel), Authority::Declared, kind, nested);
            }
        }
    }
}

/// `package.json`: electron-builder's `build.icon` family, and the `icon` a VS
/// Code extension declares. An electron icon is often `.icns`, which no webview
/// draws - `offer` rejects it, and the sibling PNG that usually sits beside it
/// is picked up as a convention instead.
fn from_package_json(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    let Some(json) = read_json(&dir.join("package.json")) else { return };
    for ptr in ["/build/icon", "/build/mac/icon", "/build/win/icon", "/build/linux/icon", "/icon"] {
        let Some(rel) = json.pointer(ptr).and_then(|v| v.as_str()) else { continue };
        let target = join_declared(dir, rel);
        // electron-builder accepts a DIRECTORY of sized icons as well as a file.
        if target.is_dir() {
            offer_largest_png(out, &target, Authority::Declared, Kind::AppIcon, nested);
        } else {
            offer(out, target, Authority::Declared, Kind::AppIcon, nested);
        }
    }
}

/// A web app manifest's `icons` array. Every entry is offered; ranking picks the
/// largest, so the `sizes` string never has to be parsed or trusted.
fn from_web_manifest(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    const MANIFESTS: &[&str] = &[
        "public/manifest.json",
        "public/manifest.webmanifest",
        "public/site.webmanifest",
        "static/manifest.json",
        "static/manifest.webmanifest",
        "manifest.webmanifest",
        "site.webmanifest",
    ];
    for rel in MANIFESTS {
        let conf = dir.join(rel);
        let Some(json) = read_json(&conf) else { continue };
        let Some(icons) = json.get("icons").and_then(|v| v.as_array()) else { continue };
        let base = conf.parent().unwrap_or(dir);
        for icon in icons {
            // `purpose: "monochrome"` is a mask, not a mark: it renders as a
            // silhouette and would read as a solid blob at 16px.
            if icon.get("purpose").and_then(|v| v.as_str()).is_some_and(|p| p.contains("monochrome")) {
                continue;
            }
            if let Some(src) = icon.get("src").and_then(|v| v.as_str()) {
                offer(out, join_declared(base, src), Authority::Declared, Kind::AppIcon, nested);
            }
        }
    }
}

/// iOS / macOS: an `AppIcon.appiconset`'s `Contents.json` names every rendition
/// with its point size and scale. Offering them all lets ranking pick the
/// largest without this having to reimplement the comparison.
fn from_appiconset(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    for set in find_appiconsets(dir) {
        let contents = set.join("Contents.json");
        let Some(json) = read_json(&contents) else { continue };
        let Some(images) = json.get("images").and_then(|v| v.as_array()) else { continue };
        for image in images {
            if let Some(name) = image.get("filename").and_then(|v| v.as_str()) {
                offer(out, set.join(name), Authority::Declared, Kind::AppIcon, nested);
            }
        }
    }
}

/// Locate `*.xcassets/AppIcon.appiconset` at the project root or one directory
/// in - an Xcode project keeps its assets under a folder named for the target
/// (`NetCheck/Assets.xcassets`), and a React Native or Flutter app under
/// `ios/`. Two levels is enough for both and bounds the walk.
fn find_appiconsets(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut roots = vec![dir.to_path_buf()];
    for entry in read_dirs(dir) {
        roots.push(entry);
    }
    for root in roots {
        for child in read_dirs(&root) {
            if child.extension().is_some_and(|e| e == "xcassets") {
                let set = child.join("AppIcon.appiconset");
                if set.is_dir() {
                    found.push(set);
                }
            }
        }
    }
    found.sort();
    found
}

// ---------------------------------------------------------------------------
// Convention resolvers
// ---------------------------------------------------------------------------

/// Android's launcher icon, densest first. The `mipmap-anydpi-v26` variant is
/// skipped on purpose: it is an XML adaptive icon pointing at vector drawables,
/// and neither is something a webview can draw.
fn from_android(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    const RES_DIRS: &[&str] = &["android/app/src/main/res", "app/src/main/res", "android/src/main/res", "res"];
    const DENSITIES: &[&str] = &["mipmap-xxxhdpi", "mipmap-xxhdpi", "mipmap-xhdpi", "mipmap-hdpi", "mipmap-mdpi"];
    for res in RES_DIRS {
        let base = dir.join(res);
        if !base.is_dir() {
            continue;
        }
        for (di, density) in DENSITIES.iter().enumerate() {
            for (ni, name) in ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher.webp", "ic_launcher_foreground.png"]
                .iter()
                .enumerate()
            {
                let path = base.join(density).join(name);
                offer_ranked(out, path, Authority::Conventional, Kind::AppIcon, nested, di * 8 + ni);
            }
        }
    }
}

/// Paths an ecosystem reserves for icons. Unlike the generic sweep below, a hit
/// here means the framework put it there, so it outranks a loose file.
fn from_conventional(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    const RESERVED: &[(&str, &[&str], Kind)] = &[
        // Tauri and Electron bundle icon sets.
        ("src-tauri/icons", &["icon.png", "128x128@2x.png", "128x128.png", "32x32.png"], Kind::AppIcon),
        ("build/icons", &["icon.png", "512x512.png", "256x256.png"], Kind::AppIcon),
        ("build", &["icon.png"], Kind::AppIcon),
        ("resources", &["icon.png"], Kind::AppIcon),
        // Flutter's web target, which mirrors the launcher icon.
        ("web/icons", &["Icon-512.png", "Icon-192.png"], Kind::AppIcon),
        ("web", &["favicon.png"], Kind::Favicon),
        // Expo's usual layout when the config is JS and cannot be read.
        ("assets/images/appIcon", &["icon.png", "adaptive-icon.png"], Kind::AppIcon),
        ("assets/icons", &["icon.png", "app-icon.png"], Kind::AppIcon),
        ("assets", &["icon.png", "app-icon.png", "adaptive-icon.png"], Kind::AppIcon),
        // Next.js app router treats these as route files.
        ("app", &["icon.svg", "icon.png", "apple-icon.png", "favicon.ico"], Kind::Favicon),
        ("src/app", &["icon.svg", "icon.png", "apple-icon.png", "favicon.ico"], Kind::Favicon),
    ];
    for (sub, names, kind) in RESERVED {
        let base = dir.join(sub);
        if !base.is_dir() {
            continue;
        }
        for (i, name) in names.iter().enumerate() {
            offer_ranked(out, base.join(name), Authority::Conventional, *kind, nested, i);
        }
    }
}

/// The generic sweep: plausible files in plausible places. Lowest authority,
/// because "there is a logo.png in assets/" is a guess about what the project
/// considers its identity.
fn from_generic(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    const FAVICONS: &[&str] = &["favicon.svg", "favicon.ico", "favicon.png", "icon.svg", "icon.png", "apple-touch-icon.png"];
    const LOGOS: &[&str] = &["logo.svg", "logo.png", "logo.webp"];
    const PLACES: &[&str] = &["public", "static", "src/assets", "src/assets/images", "assets", "src", "img", "images", ""];
    for place in PLACES {
        let base = if place.is_empty() { dir.to_path_buf() } else { dir.join(place) };
        if !base.is_dir() {
            continue;
        }
        for (i, name) in FAVICONS.iter().enumerate() {
            offer_ranked(out, base.join(name), Authority::Generic, Kind::Favicon, nested, i);
        }
        for (i, name) in LOGOS.iter().enumerate() {
            offer_ranked(out, base.join(name), Authority::Generic, Kind::Logo, nested, i);
        }
    }
}

/// Icons that are named for the product rather than for the slot they fill -
/// `blood-connect-icon.svg`, `saga-logo.png`. The fixed-name probes above
/// cannot express these, so this is the one resolver that LISTS a directory
/// instead of asking about known names.
///
/// Kept deliberately weak. It is Generic/Logo, so a real `favicon.ico` in the
/// same folder always wins; it never recurses, because a docs site's `public/`
/// has whole subtrees of `*-icon.png` UI art that is not the project's mark;
/// and it takes only the first few sorted matches so one messy folder cannot
/// flood the ranking.
fn from_named_marks(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    const PLACES: &[&str] = &["public", "static", "assets", "src/assets", "img", "images"];
    const MAX_PER_PLACE: usize = 4;
    for place in PLACES {
        let base = dir.join(place);
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        let mut matches: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = file_name_of(p);
                let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name);
                p.is_file() && (stem.contains("icon") || stem.contains("logo"))
            })
            .collect();
        matches.sort();
        for m in matches.into_iter().take(MAX_PER_PLACE) {
            offer(out, m, Authority::Generic, Kind::Logo, nested);
        }
    }
}

// ---------------------------------------------------------------------------
// Directory helpers and monorepo descent
// ---------------------------------------------------------------------------

/// Immediate subdirectories, skipping dotfiles and build output. Sorted, so
/// everything downstream of it is deterministic.
fn read_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir() && {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str())
            }
        })
        .collect();
    out.sort();
    out
}

/// The largest PNG directly inside `dir`, for an electron-builder icon folder.
fn offer_largest_png(out: &mut Vec<Candidate>, dir: &Path, a: Authority, k: Kind, nested: bool) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut pngs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| ext_of(p) == "png").collect();
    pngs.sort();
    for png in pngs {
        offer(out, png, a, k, nested);
    }
}

/// How many workspace members are worth looking inside. A monorepo's icon is in
/// one of the first few apps; walking forty packages to find nothing is not.
const MAX_MEMBERS: usize = 8;

/// Workspace members, preferring what the repo DECLARES over what we can guess.
/// `package.json` `workspaces` and `pnpm-workspace.yaml` both give a glob list;
/// only the single trailing `*` form is expanded, which is the form in practice.
fn workspace_members(dir: &Path) -> Vec<PathBuf> {
    let mut globs: Vec<String> = Vec::new();

    if let Some(json) = read_json(&dir.join("package.json")) {
        let declared = json
            .get("workspaces")
            .and_then(|w| w.as_array().cloned().or_else(|| w.get("packages")?.as_array().cloned()));
        if let Some(list) = declared {
            globs.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
        }
    }
    // pnpm-workspace.yaml is a one-key file; a line scan reads it without
    // dragging in a YAML parser for this alone.
    if let Ok(text) = std::fs::read_to_string(dir.join("pnpm-workspace.yaml")) {
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("- ") {
                globs.push(rest.trim().trim_matches(['"', '\'']).to_string());
            }
        }
    }
    // Nothing declared: fall back to the directory names an app usually sits in.
    if globs.is_empty() {
        globs = ["frontend", "web", "app", "client", "www", "site", "desktop", "mobile"]
            .iter()
            .map(|s| s.to_string())
            .chain(["apps/*", "packages/*", "clients/*"].iter().map(|s| s.to_string()))
            .collect();
    }

    let mut members: Vec<PathBuf> = Vec::new();
    for glob in globs {
        if let Some(prefix) = glob.strip_suffix("/*") {
            members.extend(read_dirs(&dir.join(prefix)));
        } else if !glob.contains('*') {
            let p = dir.join(&glob);
            if p.is_dir() {
                members.push(p);
            }
        }
    }
    // A declared glob can still point somewhere we refuse to read: `workspaces:
    // ["node_modules/*"]` is legal and `read_dirs` cannot catch it, because it
    // only ever sees the CHILD's name ("react"), never the skipped parent. So
    // the whole path below the project is re-checked here.
    members.retain(|m| {
        m.strip_prefix(dir).map(|rel| {
            !rel.components().any(|c| SKIP_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
        }).unwrap_or(false)
    });
    members.sort();
    members.dedup();
    members.truncate(MAX_MEMBERS);
    members
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/// Every candidate `dir` offers about itself, at one nesting level.
fn collect(dir: &Path, out: &mut Vec<Candidate>, nested: bool) {
    from_tauri(dir, out, nested);
    from_expo(dir, out, nested);
    from_package_json(dir, out, nested);
    from_web_manifest(dir, out, nested);
    from_appiconset(dir, out, nested);
    from_android(dir, out, nested);
    from_conventional(dir, out, nested);
    from_generic(dir, out, nested);
    from_named_marks(dir, out, nested);
}

/// Everything `dir` offers, including one level of workspace members.
fn collect_all(dir: &Path, out: &mut Vec<Candidate>) {
    collect(dir, out, false);
    for member in workspace_members(dir) {
        collect(&member, out, true);
    }
}

/// Highest score wins; then the resolver's own preference; then the path, so
/// the answer never depends on the order a directory listing came back in.
fn best(candidates: Vec<Candidate>) -> Option<String> {
    candidates
        .into_iter()
        .max_by(|a, b| {
            score(a)
                .cmp(&score(b))
                .then_with(|| b.rank.cmp(&a.rank))
                .then_with(|| b.path.cmp(&a.path))
        })
        .map(|c| c.path.to_string_lossy().into_owned())
}

/// The icon for a project, given the project directory and the working folders
/// of its branch-units (empty for a project that is its own working folder).
///
/// Pure over the filesystem: hand it directories and it answers about them, so
/// the whole ranking is testable without a cache, a config, or a git repo.
///
/// A worktree container's own root holds `.bare` and the per-branch folders, so
/// everything worth finding is one level down - but WHICH worktree is asked
/// matters, and git's listing order is not something to hang a project's
/// identity on. So every folder is scored into one pool and the best candidate
/// across all of them wins, with the path breaking ties. Adding or removing a
/// worktree can then only change the icon if it genuinely brought a better one.
pub fn resolve_project_icon(project: &Path, folders: &[PathBuf]) -> Option<String> {
    let mut dirs: Vec<PathBuf> = vec![project.to_path_buf()];
    for f in folders {
        if f != project && !dirs.contains(f) {
            dirs.push(f.clone());
        }
    }
    dirs.sort();
    // Bounded: a container with twenty worktrees must not turn one discovery
    // into twenty full resolutions.
    dirs.truncate(4);

    let mut candidates = Vec::new();
    for dir in &dirs {
        collect_all(dir, &mut candidates);
    }
    best(candidates)
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/// Memoized resolution, keyed on the project directory's mtime.
///
/// Resolution reads manifests and walks workspace members, which is too much to
/// repeat for every project on every `config://changed`. The key is a proxy, not
/// a guarantee: adding `public/favicon.svg` changes `public/`'s mtime, not the
/// project root's, so a newly added icon appears on the next restart or the next
/// change that does touch the root. That is the right trade for a decoration.
type IconCache = HashMap<PathBuf, (SystemTime, Option<String>)>;
static CACHE: OnceLock<Mutex<IconCache>> = OnceLock::new();

fn dir_mtime(dir: &Path) -> Option<SystemTime> {
    std::fs::metadata(dir).ok()?.modified().ok()
}

pub fn cached_project_icon(project: &Path, folders: &[PathBuf]) -> Option<String> {
    let Some(mtime) = dir_mtime(project) else {
        return resolve_project_icon(project, folders);
    };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some((seen, hit)) = map.get(project) {
            if *seen == mtime {
                return hit.clone();
            }
        }
    }
    let resolved = resolve_project_icon(project, folders);
    if let Ok(mut map) = cache.lock() {
        map.insert(project.to_path_buf(), (mtime, resolved.clone()));
    }
    resolved
}

// ---------------------------------------------------------------------------
// The upload store (unchanged in shape: a user's own pick is never detected)
// ---------------------------------------------------------------------------

/// Where uploaded icons are copied to. Beside `sway.toml`, so a project's icon
/// travels with the config rather than pointing at a file the user may move or
/// delete out from under it.
pub fn icons_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/icons")
}

/// FNV-1a (64-bit). Used only to name a stored file; nothing depends on it
/// being cryptographic, only on it being stable and cheap.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// A filesystem-safe stem from a project path's basename. Lowercased, with any
/// run of unsupported characters collapsed to one dash, so the stored filename
/// stays recognisable when a human looks in the icons dir.
pub fn slug(project_path: &str) -> String {
    let base = Path::new(project_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut out = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let capped: String = trimmed.chars().take(40).collect();
    if capped.is_empty() {
        "project".into()
    } else {
        capped
    }
}

/// The lowercase extension of `source`, if it is one we accept for an upload.
fn accepted_ext(source: &Path) -> Result<String, String> {
    let ext = ext_of(source);
    if UPLOAD_EXTS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err("Icon must be an .svg, .png or .ico file".into())
    }
}

/// The name an icon is stored under: `<project-slug>-<hash>.<ext>`, where the
/// hash covers the project path AND the file's bytes. Hashing the content (not
/// just the path) means replacing a project's icon always yields a *new* file
/// name, so the webview cannot serve the previous image from its cache.
pub fn stored_name(project_path: &str, content: &[u8], ext: &str) -> String {
    let mut seed = project_path.as_bytes().to_vec();
    seed.extend_from_slice(content);
    format!("{}-{:016x}.{}", slug(project_path), fnv1a(&seed), ext)
}

/// Copy `source` into the icon store for `project_path`, returning the stored
/// absolute path. Validates the extension and the size first, so a bad pick
/// fails before anything is written.
pub fn store_icon(project_path: &str, source: &Path) -> Result<String, String> {
    let ext = accepted_ext(source)?;
    let meta = std::fs::metadata(source).map_err(|e| format!("Cannot read that file: {e}"))?;
    if !meta.is_file() {
        return Err("That is not a file".into());
    }
    if meta.len() > MAX_ICON_BYTES {
        return Err("Icon is larger than 2 MB".into());
    }
    let bytes = std::fs::read(source).map_err(|e| format!("Cannot read that file: {e}"))?;
    let dir = icons_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(stored_name(project_path, &bytes, &ext));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Delete a previously stored icon, but only when it really is one of ours and
/// is not the file we just wrote. Guarding on the parent directory keeps a
/// hand-edited `icon_file = "~/Pictures/logo.png"` from being deleted by an
/// icon change: the config may point anywhere, the store is the only thing we
/// are allowed to clean up.
pub fn prune_stored(old: Option<&str>, keep: Option<&str>) {
    let Some(old) = old else { return };
    if Some(old) == keep {
        return;
    }
    let path = PathBuf::from(old);
    if path.parent() == Some(icons_dir().as_path()) {
        let _ = std::fs::remove_file(path);
    }
}

/// Native file picker for an icon image. Unfiltered on purpose: AppleScript's
/// `of type` list is quietly inconsistent about extensions vs UTIs, and a
/// filter that matches nothing is worse than none - `store_icon` rejects an
/// unsupported pick with a message the user can act on. Mirrors `pick_folder`:
/// a cancel is `Ok(None)`, not an error.
#[tauri::command(async)]
pub fn pick_icon_file() -> Result<Option<String>, String> {
    let out = Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose file with prompt \"Choose an icon image (SVG, PNG or ICO)\")",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None); // cancelled
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Unique per test AND per process: two `cargo test` runs in parallel (or a
    // rerun while the previous one is finishing) must not share a directory.
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    fn tmp(name: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "sway_icons_test_{}_{}_{name}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write a file, creating its parents. Content is irrelevant unless the test
    /// is about ranking by resolution, so the default is a single byte.
    fn touch(dir: &Path, rel: &str) {
        write(dir, rel, b"x");
    }

    fn write(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, bytes).unwrap();
    }

    /// A real PNG header declaring `px` square. Only the first 24 bytes are ever
    /// read, so the rest of a PNG does not need to exist for ranking to work.
    fn png(px: u32) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&px.to_be_bytes());
        v.extend_from_slice(&px.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v
    }

    /// What the resolver picks, as a path relative to the project root.
    fn pick(dir: &Path) -> Option<String> {
        resolve_project_icon(dir, &[]).map(|p| {
            Path::new(&p)
                .strip_prefix(dir)
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or(p)
        })
    }

    // ---- the corpus: one minimal project per framework ----------------------

    #[test]
    fn tauri_app_uses_the_icon_its_config_declares() {
        let dir = tmp("tauri");
        write(&dir, "src-tauri/tauri.conf.json", br#"{"bundle":{"icon":["icons/32x32.png","icons/icon.png"]}}"#);
        write(&dir, "src-tauri/icons/32x32.png", &png(32));
        write(&dir, "src-tauri/icons/icon.png", &png(512));
        // A loose logo that the old first-match scan preferred over the manifest.
        touch(&dir, "src/assets/logo.svg");
        assert_eq!(pick(&dir).as_deref(), Some("src-tauri/icons/icon.png"));
    }

    #[test]
    fn tauri_v1_nests_the_same_key_under_tauri() {
        let dir = tmp("tauri1");
        write(&dir, "src-tauri/tauri.conf.json", br#"{"tauri":{"bundle":{"icon":["icons/icon.png"]}}}"#);
        write(&dir, "src-tauri/icons/icon.png", &png(256));
        assert_eq!(pick(&dir).as_deref(), Some("src-tauri/icons/icon.png"));
    }

    #[test]
    fn expo_app_uses_the_icon_its_app_json_declares() {
        let dir = tmp("expo");
        write(&dir, "app.json", br#"{"expo":{"icon":"./assets/images/appIcon/icon.png"}}"#);
        write(&dir, "assets/images/appIcon/icon.png", &png(1024));
        assert_eq!(pick(&dir).as_deref(), Some("assets/images/appIcon/icon.png"));
    }

    #[test]
    fn expo_layout_is_found_even_when_the_config_is_javascript() {
        // `app.config.ts` cannot be parsed, so the convention scan is the only
        // thing standing between this project and a derived glyph.
        let dir = tmp("expojs");
        touch(&dir, "app.config.ts");
        write(&dir, "assets/images/appIcon/icon.png", &png(1024));
        assert_eq!(pick(&dir).as_deref(), Some("assets/images/appIcon/icon.png"));
    }

    #[test]
    fn the_app_icon_beats_androids_layer_of_it_at_the_same_size() {
        // Both are app icons in the same folder at the same size, so nothing but
        // the resolver's own ordering can separate them - and `adaptive-icon`
        // sorts first alphabetically, which is exactly the wrong answer.
        let dir = tmp("adaptive");
        touch(&dir, "app.config.ts");
        write(&dir, "assets/images/appIcon/icon.png", &png(1024));
        write(&dir, "assets/images/appIcon/adaptive-icon.png", &png(1024));
        assert_eq!(pick(&dir).as_deref(), Some("assets/images/appIcon/icon.png"));
    }

    #[test]
    fn an_unrelated_app_json_is_never_mistaken_for_expo() {
        // A real tree here has `.obsidian/app.json` and `core/manifest.json`.
        // Anchoring is what keeps them out: the file must be at the root AND
        // carry an `expo` key.
        let dir = tmp("notexpo");
        write(&dir, "app.json", br#"{"name":"obsidian-ish","icon":"nope.png"}"#);
        touch(&dir, "nope.png");
        touch(&dir, "public/favicon.svg");
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.svg"));
    }

    #[test]
    fn electron_app_uses_the_builder_icon() {
        let dir = tmp("electron");
        write(&dir, "package.json", br#"{"build":{"mac":{"icon":"build/icon.png"}}}"#);
        write(&dir, "build/icon.png", &png(512));
        assert_eq!(pick(&dir).as_deref(), Some("build/icon.png"));
    }

    #[test]
    fn an_electron_icon_directory_resolves_to_its_largest_png() {
        let dir = tmp("electrondir");
        write(&dir, "package.json", br#"{"build":{"icon":"build/icons"}}"#);
        write(&dir, "build/icons/128x128.png", &png(128));
        write(&dir, "build/icons/512x512.png", &png(512));
        assert_eq!(pick(&dir).as_deref(), Some("build/icons/512x512.png"));
    }

    #[test]
    fn an_icns_declaration_falls_through_to_a_drawable_sibling() {
        // No webview draws .icns, so the declaration is unusable and the PNG
        // beside it has to carry the project.
        let dir = tmp("icns");
        write(&dir, "package.json", br#"{"build":{"mac":{"icon":"build/icon.icns"}}}"#);
        touch(&dir, "build/icon.icns");
        write(&dir, "build/icon.png", &png(512));
        assert_eq!(pick(&dir).as_deref(), Some("build/icon.png"));
    }

    #[test]
    fn ios_app_uses_the_largest_rendition_its_appiconset_declares() {
        let dir = tmp("ios");
        write(
            &dir,
            "NetCheck/Assets.xcassets/AppIcon.appiconset/Contents.json",
            br#"{"images":[{"filename":"icon_32x32.png","size":"32x32","scale":"1x"},
                          {"filename":"Logo_1024.png","size":"512x512","scale":"2x"}]}"#,
        );
        write(&dir, "NetCheck/Assets.xcassets/AppIcon.appiconset/icon_32x32.png", &png(32));
        write(&dir, "NetCheck/Assets.xcassets/AppIcon.appiconset/Logo_1024.png", &png(1024));
        assert_eq!(
            pick(&dir).as_deref(),
            Some("NetCheck/Assets.xcassets/AppIcon.appiconset/Logo_1024.png")
        );
    }

    #[test]
    fn android_app_uses_the_densest_launcher_icon() {
        let dir = tmp("android");
        write(&dir, "android/app/src/main/res/mipmap-mdpi/ic_launcher.png", &png(48));
        write(&dir, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", &png(192));
        // The adaptive XML must never be chosen: a webview cannot draw it.
        touch(&dir, "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
        assert_eq!(
            pick(&dir).as_deref(),
            Some("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")
        );
    }

    #[test]
    fn flutter_app_uses_its_web_icon() {
        let dir = tmp("flutter");
        touch(&dir, "pubspec.yaml");
        write(&dir, "web/icons/Icon-512.png", &png(512));
        write(&dir, "web/favicon.png", &png(32));
        assert_eq!(pick(&dir).as_deref(), Some("web/icons/Icon-512.png"));
    }

    #[test]
    fn a_web_manifest_beats_a_loose_favicon() {
        let dir = tmp("webmanifest");
        write(
            &dir,
            "public/site.webmanifest",
            br#"{"icons":[{"src":"/android-chrome-512x512.png","sizes":"512x512"}]}"#,
        );
        write(&dir, "public/android-chrome-512x512.png", &png(512));
        write(&dir, "public/favicon.ico", &png(32));
        assert_eq!(pick(&dir).as_deref(), Some("public/android-chrome-512x512.png"));
    }

    #[test]
    fn a_monochrome_manifest_icon_is_skipped() {
        // A maskable monochrome entry renders as a silhouette, which is a blob
        // at 16px.
        let dir = tmp("mono");
        write(
            &dir,
            "public/manifest.json",
            br#"{"icons":[{"src":"/mask.png","sizes":"512x512","purpose":"monochrome"}]}"#,
        );
        write(&dir, "public/mask.png", &png(512));
        write(&dir, "public/favicon.svg", b"<svg/>");
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.svg"));
    }

    #[test]
    fn plain_web_apps_still_resolve_their_favicon() {
        for (place, file) in [
            ("public", "favicon.svg"),
            ("static", "favicon.ico"),
            ("src/assets", "favicon.png"),
            ("", "favicon.ico"),
        ] {
            let dir = tmp("web");
            let rel = if place.is_empty() { file.to_string() } else { format!("{place}/{file}") };
            write(&dir, &rel, &png(64));
            assert_eq!(pick(&dir).as_deref(), Some(rel.as_str()), "for {rel}");
        }
    }

    #[test]
    fn next_app_router_icons_outrank_a_marketing_logo() {
        let dir = tmp("next");
        write(&dir, "src/app/icon.png", &png(256));
        touch(&dir, "public/logo.png");
        assert_eq!(pick(&dir).as_deref(), Some("src/app/icon.png"));
    }

    // ---- monorepos ----------------------------------------------------------

    #[test]
    fn a_declared_workspace_member_supplies_the_icon() {
        let dir = tmp("workspaces");
        write(&dir, "package.json", br#"{"workspaces":["core/application","clients/organization"]}"#);
        write(&dir, "clients/organization/public/blood-connect-icon.svg", b"<svg/>");
        assert_eq!(
            pick(&dir).as_deref(),
            Some("clients/organization/public/blood-connect-icon.svg")
        );
    }

    #[test]
    fn an_icon_named_for_the_product_is_found() {
        let dir = tmp("named");
        write(&dir, "public/blood-connect-icon.svg", b"<svg/>");
        assert_eq!(pick(&dir).as_deref(), Some("public/blood-connect-icon.svg"));
    }

    #[test]
    fn a_product_named_icon_still_loses_to_a_real_favicon() {
        // The loose name scan is the weakest evidence there is: a docs site's
        // `public/` is full of `*-icon.png` UI art that is not its identity.
        let dir = tmp("named2");
        write(&dir, "public/custom-blocks-icon.png", &png(512));
        write(&dir, "public/favicon.ico", &png(32));
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.ico"));
    }

    #[test]
    fn a_pnpm_workspace_glob_is_expanded() {
        let dir = tmp("pnpm");
        write(&dir, "pnpm-workspace.yaml", b"packages:\n  - 'apps/*'\n");
        write(&dir, "apps/web/public/favicon.svg", b"<svg/>");
        assert_eq!(pick(&dir).as_deref(), Some("apps/web/public/favicon.svg"));
    }

    #[test]
    fn an_undeclared_nested_app_dir_is_still_found() {
        // No root package.json at all, which is how a worktree of a split repo
        // arrives.
        let dir = tmp("nested");
        write(&dir, "frontend/public/favicon.ico", &png(64));
        assert_eq!(pick(&dir).as_deref(), Some("frontend/public/favicon.ico"));
    }

    #[test]
    fn the_root_beats_a_workspace_member() {
        // A member's icon is real, but it is not the container's identity.
        let dir = tmp("rootwins");
        write(&dir, "package.json", br#"{"workspaces":["apps/*"]}"#);
        write(&dir, "public/favicon.svg", b"<svg/>");
        write(&dir, "apps/web/public/favicon.svg", b"<svg/>");
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.svg"));
    }

    // ---- refusing to be confidently wrong -----------------------------------

    #[test]
    fn scaffold_art_is_refused_even_when_it_is_all_there_is() {
        // A dozen projects showing the Vite logo is worse than a dozen showing
        // a dozen different derived glyphs.
        let dir = tmp("scaffold");
        touch(&dir, "public/vite.svg");
        assert_eq!(pick(&dir), None);
    }

    #[test]
    fn scaffold_art_loses_to_a_real_icon() {
        let dir = tmp("scaffold2");
        touch(&dir, "public/vite.svg");
        write(&dir, "public/favicon.svg", b"<svg/>");
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.svg"));
    }

    #[test]
    fn small_is_not_the_same_as_default() {
        // A real hand-drawn favicon in this very tree is 299 bytes. Size must
        // never become a rejection signal.
        let dir = tmp("small");
        write(&dir, "public/favicon.svg", br#"<svg viewBox="0 0 32 32"><rect/></svg>"#);
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.svg"));
    }

    #[test]
    fn a_project_with_no_icon_says_so() {
        let dir = tmp("none");
        touch(&dir, "src/main.rs");
        touch(&dir, "README.md");
        assert_eq!(pick(&dir), None);
    }

    #[test]
    fn dependency_and_build_trees_are_never_searched() {
        let dir = tmp("skip");
        write(&dir, "package.json", br#"{"workspaces":["node_modules/*"]}"#);
        touch(&dir, "node_modules/react/public/favicon.ico");
        touch(&dir, "target/icon.png");
        assert_eq!(pick(&dir), None);
    }

    #[test]
    fn a_directory_named_like_an_icon_is_not_one() {
        let dir = tmp("dirnamed");
        std::fs::create_dir_all(dir.join("public/favicon.ico")).unwrap();
        write(&dir, "public/logo.png", &png(128));
        assert_eq!(pick(&dir).as_deref(), Some("public/logo.png"));
    }

    // ---- ranking and determinism -------------------------------------------

    #[test]
    fn a_vector_beats_a_raster_of_equal_standing() {
        let dir = tmp("vector");
        write(&dir, "public/favicon.png", &png(512));
        write(&dir, "public/favicon.svg", b"<svg/>");
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.svg"));
    }

    #[test]
    fn a_bigger_raster_beats_a_smaller_one() {
        let dir = tmp("bigger");
        write(&dir, "public/icon.png", &png(512));
        write(&dir, "public/favicon.png", &png(16));
        assert_eq!(pick(&dir).as_deref(), Some("public/icon.png"));
    }

    #[test]
    fn a_favicon_beats_a_marketing_logo() {
        let dir = tmp("favlogo");
        write(&dir, "public/logo.png", &png(128));
        write(&dir, "public/favicon.png", &png(128));
        assert_eq!(pick(&dir).as_deref(), Some("public/favicon.png"));
    }

    #[test]
    fn the_answer_does_not_depend_on_the_order_worktrees_are_reported() {
        // The container itself holds nothing; two worktrees each hold an icon.
        // Whichever order git lists them in, the same one must win.
        let root = tmp("worktrees");
        let a = root.join("alpha");
        let b = root.join("beta");
        write(&a, "public/favicon.svg", b"<svg/>");
        write(&b, "public/favicon.png", &png(64));

        let forward = resolve_project_icon(&root, &[a.clone(), b.clone()]);
        let backward = resolve_project_icon(&root, &[b.clone(), a.clone()]);
        assert_eq!(forward, backward);
        // And it is the better of the two, not merely the first.
        assert!(forward.unwrap().ends_with("alpha/public/favicon.svg"));
    }

    #[test]
    fn two_equally_ranked_candidates_break_the_tie_the_same_way_every_time() {
        let dir = tmp("tie");
        write(&dir, "public/favicon.png", &png(128));
        write(&dir, "static/favicon.png", &png(128));
        let first = pick(&dir);
        assert!(first.is_some());
        for _ in 0..5 {
            assert_eq!(pick(&dir), first);
        }
    }

    /// A diagnostic, not a test: walks the real `~/Projects` tree and reports
    /// what every project resolves to, so a change to the ranking can be judged
    /// against actual repositories rather than only against the synthesized
    /// corpus above. Ignored by default because it depends on a machine's own
    /// filesystem and asserts nothing.
    ///
    ///   cargo test --lib report_real_projects -- --ignored --nocapture
    #[test]
    #[ignore]
    fn report_real_projects() {
        let Some(root) = dirs::home_dir().map(|h| h.join("Projects")) else { return };
        let (mut hit, mut miss) = (0, 0);
        let mut seen: HashMap<String, Vec<String>> = HashMap::new();
        for space in read_dirs(&root) {
            for project in read_dirs(&space) {
                let name = format!(
                    "{}/{}",
                    space.file_name().unwrap().to_string_lossy(),
                    project.file_name().unwrap().to_string_lossy()
                );
                let folders = read_dirs(&project);
                match resolve_project_icon(&project, &folders) {
                    Some(p) => {
                        hit += 1;
                        let rel = Path::new(&p).strip_prefix(&project).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| p.clone());
                        println!("  HIT  {name:<32} {rel}");
                        if let Ok(bytes) = std::fs::read(&p) {
                            seen.entry(format!("{:016x}", fnv1a(&bytes))).or_default().push(name);
                        }
                    }
                    None => {
                        miss += 1;
                        println!("  ---  {name}");
                    }
                }
            }
        }
        println!("\n  {hit} resolved, {miss} on a derived glyph");
        for (h, names) in seen.iter().filter(|(_, v)| v.len() > 1) {
            println!("  identical ({h}): {}", names.join(", "));
        }
    }

    // ---- the upload store ---------------------------------------------------

    #[test]
    fn slug_is_filesystem_safe_and_bounded() {
        assert_eq!(slug("/Users/me/Projects/personal/My Project!"), "my-project");
        assert_eq!(slug("/a/b/.hidden"), "hidden");
        assert_eq!(slug("/"), "project");
        assert!(slug(&format!("/a/{}", "x".repeat(80))).len() <= 40);
    }

    #[test]
    fn stored_name_changes_with_content_so_a_replacement_never_reuses_a_url() {
        let a = stored_name("/p/sway", b"first", "png");
        let b = stored_name("/p/sway", b"second", "png");
        assert_ne!(a, b);
        assert_eq!(a, stored_name("/p/sway", b"first", "png"));
        assert!(a.starts_with("sway-") && a.ends_with(".png"));
    }

    #[test]
    fn stored_name_separates_two_projects_of_the_same_basename() {
        assert_ne!(stored_name("/one/app", b"same", "svg"), stored_name("/two/app", b"same", "svg"));
    }

    #[test]
    fn store_icon_rejects_an_unsupported_type() {
        let dir = tmp("reject");
        touch(&dir, "notes.pdf");
        let err = store_icon("/p/x", &dir.join("notes.pdf")).unwrap_err();
        assert!(err.contains(".svg"), "got {err}");
    }

    #[test]
    fn store_icon_rejects_a_missing_file() {
        let dir = tmp("missing");
        assert!(store_icon("/p/x", &dir.join("gone.png")).is_err());
    }

    #[test]
    fn prune_leaves_a_file_outside_the_store_alone() {
        let dir = tmp("prune");
        touch(&dir, "mine.png");
        let outside = dir.join("mine.png");
        prune_stored(Some(&outside.to_string_lossy()), Some("/elsewhere/new.png"));
        assert!(outside.exists(), "a user-owned path must never be deleted");
    }

    #[test]
    fn prune_keeps_the_file_it_was_told_to_keep() {
        // A re-pick of the identical image hashes to the identical name, so the
        // "old" and "new" paths are one file - deleting it would blank the icon.
        let dir = tmp("keep");
        touch(&dir, "same.png");
        let same = dir.join("same.png").to_string_lossy().into_owned();
        prune_stored(Some(&same), Some(&same));
        assert!(Path::new(&same).exists());
    }
}
