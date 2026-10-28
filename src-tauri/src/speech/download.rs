use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use sha2::{Digest, Sha256};

const BASE: &str =
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";

pub const CANCELLED: &str = "cancelled";

pub struct Size {
    pub id: &'static str,
    pub file: &'static str,
    sha256: &'static str,
    bytes: u64,
}

pub const SIZES: [Size; 2] = [
    Size {
        id: "int8",
        file: "model_quantized.onnx",
        sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
        bytes: 92_361_116,
    },
    Size {
        id: "full",
        file: "model.onnx",
        sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
        bytes: 325_532_232,
    },
];

const TOKENIZER: (&str, u64) = (
    "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    3_497,
);

const VOICE_BYTES: u64 = 522_240;

const VOICES: [(&str, &str); 28] = [
    (
        "af_alloy",
        "c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45",
    ),
    (
        "af_aoede",
        "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361",
    ),
    (
        "af_bella",
        "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b",
    ),
    (
        "af_heart",
        "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    ),
    (
        "af_jessica",
        "a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8",
    ),
    (
        "af_kore",
        "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e",
    ),
    (
        "af_nicole",
        "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a",
    ),
    (
        "af_nova",
        "18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f",
    ),
    (
        "af_river",
        "00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30",
    ),
    (
        "af_sarah",
        "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a",
    ),
    (
        "af_sky",
        "4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9",
    ),
    (
        "am_adam",
        "162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716",
    ),
    (
        "am_echo",
        "3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3",
    ),
    (
        "am_eric",
        "e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832",
    ),
    (
        "am_fenrir",
        "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43",
    ),
    (
        "am_liam",
        "52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade",
    ),
    (
        "am_michael",
        "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
    ),
    (
        "am_onyx",
        "da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6",
    ),
    (
        "am_puck",
        "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0",
    ),
    (
        "am_santa",
        "61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a",
    ),
    (
        "bf_alice",
        "08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573",
    ),
    (
        "bf_emma",
        "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73",
    ),
    (
        "bf_isabella",
        "3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f",
    ),
    (
        "bf_lily",
        "5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335",
    ),
    (
        "bm_daniel",
        "6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8",
    ),
    (
        "bm_fable",
        "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1",
    ),
    (
        "bm_george",
        "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
    ),
    (
        "bm_lewis",
        "b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97",
    ),
];

pub struct Pinned {
    pub path: String,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

fn pinned(path: String, from: &str, sha256: &str, bytes: u64) -> Pinned {
    Pinned {
        path,
        url: format!("{BASE}/{from}"),
        sha256: sha256.into(),
        bytes,
    }
}

pub fn manifest(size: &str) -> Option<Vec<Pinned>> {
    let model = SIZES.iter().find(|s| s.id == size)?;
    let mut files = vec![pinned(
        "tokenizer.json".into(),
        "tokenizer.json",
        TOKENIZER.0,
        TOKENIZER.1,
    )];
    files.extend(VOICES.iter().map(|(name, sha)| {
        let path = format!("voices/{name}.bin");
        pinned(path.clone(), &path, sha, VOICE_BYTES)
    }));
    files.push(pinned(
        model.file.into(),
        &format!("onnx/{}", model.file),
        model.sha256,
        model.bytes,
    ));
    Some(files)
}

pub type Fetch<'a> = &'a dyn Fn(&str) -> Result<Box<dyn Read>, String>;

// One agent for the whole download, so its 30 files share connections. A
// model file sits behind a redirect to Hugging Face's object store.
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(5)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_per_read(Some(Duration::from_secs(30)))
        .build()
        .into()
});

pub fn fetch(url: &str) -> Result<Box<dyn Read>, String> {
    let response = AGENT
        .get(url)
        .header("User-Agent", "tori-speech-download")
        .call()
        .map_err(|e| e.to_string())?;
    Ok(Box::new(response.into_body().into_reader()))
}

pub fn install(
    dir: &Path,
    files: &[Pinned],
    fetch: Fetch,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let staging = dir.join(".download");
    let _ = std::fs::remove_dir_all(&staging);
    let result = fill(&staging, files, fetch, cancelled, progress).and_then(|()| swap_in(dir, &staging, files));
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn fill(
    staging: &Path,
    files: &[Pinned],
    fetch: Fetch,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    let mut done = 0;
    let mut shown = 0;
    let mut buf = vec![0; 64 * 1024];
    for f in files {
        let path = staging.join(&f.path);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut body = fetch(&f.url)?;
        let mut hash = Sha256::new();
        let mut got = 0;
        loop {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            let n = body.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
            if n == 0 {
                break;
            }
            got += n as u64;
            if got > f.bytes {
                return Err(format!("{} is larger than expected", f.path));
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if done * 100 / total > shown {
                shown = done * 100 / total;
                progress(done, total);
            }
        }
        if format!("{:x}", hash.finalize()) != f.sha256 {
            return Err(format!("{}: checksum mismatch", f.path));
        }
    }
    Ok(())
}

fn is_model(path: &str) -> bool {
    SIZES.iter().any(|s| s.file == path)
}

// The model goes in last: its presence is what counts as installed, so a move
// that fails partway never looks like a finished download.
fn swap_in(dir: &Path, staging: &Path, files: &[Pinned]) -> Result<(), String> {
    let (models, rest): (Vec<&Pinned>, Vec<&Pinned>) = files.iter().partition(|f| is_model(&f.path));
    for f in rest.into_iter().chain(models) {
        let to = dir.join(&f.path);
        std::fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::rename(staging.join(&f.path), &to).map_err(|e| format!("cannot move {} into place: {e}", f.path))?;
    }
    for size in &SIZES {
        if !files.iter().any(|f| f.path == size.file) {
            remove_file(&dir.join(size.file))?;
        }
    }
    Ok(())
}

pub fn remove(dir: &Path) -> Result<(), String> {
    for size in &SIZES {
        remove_file(&dir.join(size.file))?;
    }
    remove_file(&dir.join("tokenizer.json"))?;
    match std::fs::remove_dir_all(dir.join("voices")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn remove_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tori_speech_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(path: &str, body: &[u8]) -> (Pinned, Vec<u8>) {
        let pinned = Pinned {
            path: path.into(),
            url: format!("https://test/{path}"),
            sha256: format!("{:x}", Sha256::digest(body)),
            bytes: body.len() as u64,
        };
        (pinned, body.to_vec())
    }

    fn served(files: &[(Pinned, Vec<u8>)]) -> HashMap<String, Vec<u8>> {
        files.iter().map(|(p, b)| (p.url.clone(), b.clone())).collect()
    }

    fn model(size: &str) -> Vec<(Pinned, Vec<u8>)> {
        let file_name = SIZES.iter().find(|s| s.id == size).unwrap().file;
        vec![
            file("tokenizer.json", b"{}"),
            file("voices/af_heart.bin", &[1; 300]),
            file(file_name, &[2; 500]),
        ]
    }

    fn run(dir: &Path, files: &[(Pinned, Vec<u8>)], cancelled: &dyn Fn() -> bool) -> Result<Vec<(u64, u64)>, String> {
        let bodies = served(files);
        let fetch = move |url: &str| -> Result<Box<dyn Read>, String> {
            Ok(Box::new(std::io::Cursor::new(bodies.get(url).cloned().ok_or("404")?)))
        };
        let pinned: Vec<Pinned> = files
            .iter()
            .map(|(p, _)| Pinned {
                path: p.path.clone(),
                url: p.url.clone(),
                sha256: p.sha256.clone(),
                bytes: p.bytes,
            })
            .collect();
        let mut seen = Vec::new();
        install(dir, &pinned, &fetch, cancelled, &mut |d, t| seen.push((d, t)))?;
        Ok(seen)
    }

    fn installed(dir: &Path) -> bool {
        super::super::installed(dir).is_some()
    }

    fn left(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = walk(dir)
            .into_iter()
            .map(|p| p.strip_prefix(dir).unwrap().display().to_string())
            .collect();
        out.sort();
        out
    }

    fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|e| {
                let p = e.path();
                if p.is_dir() {
                    walk(&p)
                } else {
                    vec![p]
                }
            })
            .collect()
    }

    #[test]
    fn each_size_fetches_its_own_model_against_its_own_hash() {
        for size in &SIZES {
            let files = manifest(size.id).unwrap();
            let model = files.last().unwrap();
            assert_eq!(model.path, size.file);
            assert_eq!(model.sha256, size.sha256);
            assert!(model.url.ends_with(&format!("/onnx/{}", size.file)));
            assert!(files.iter().any(|f| f.path == "tokenizer.json"));
            assert_eq!(files.iter().filter(|f| f.path.starts_with("voices/")).count(), 28);
        }
        assert!(manifest("half").is_none());
    }

    #[test]
    fn a_bad_hash_leaves_no_file() {
        for size in &SIZES {
            let dir = temp_dir("bad_hash");
            let mut files = model(size.id);
            files[2].0.sha256 = "0".repeat(64);
            let err = run(&dir, &files, &|| false).unwrap_err();
            assert_eq!(err, format!("{}: checksum mismatch", size.file));
            assert_eq!(left(&dir), Vec::<String>::new());
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[test]
    fn a_cancelled_download_leaves_nothing_installed() {
        let dir = temp_dir("cancelled");
        let reads = AtomicUsize::new(0);
        let err = run(&dir, &model("int8"), &|| reads.fetch_add(1, Ordering::SeqCst) >= 3).unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(!installed(&dir));
        assert_eq!(left(&dir), Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_dropped_download_leaves_nothing_installed() {
        struct Drops;
        impl Read for Drops {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::ConnectionReset.into())
            }
        }
        let dir = temp_dir("dropped");
        let files = model("int8");
        let pinned: Vec<Pinned> = files.into_iter().map(|(p, _)| p).collect();
        let fetch = |_: &str| -> Result<Box<dyn Read>, String> { Ok(Box::new(Drops)) };
        let err = install(&dir, &pinned, &fetch, &|| false, &mut |_, _| {}).unwrap_err();
        assert!(err.starts_with("download failed"), "{err}");
        assert!(!installed(&dir));
        assert_eq!(left(&dir), Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn progress_climbs_to_the_total() {
        let dir = temp_dir("progress");
        let seen = run(&dir, &model("int8"), &|| false).unwrap();
        assert!(seen.len() >= 2);
        assert!(seen.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(*seen.last().unwrap(), (802, 802));
        assert!(installed(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn switching_size_leaves_only_the_new_model() {
        let dir = temp_dir("switch");
        run(&dir, &model("int8"), &|| false).unwrap();
        run(&dir, &model("full"), &|| false).unwrap();
        assert_eq!(left(&dir), ["model.onnx", "tokenizer.json", "voices/af_heart.bin"]);
        assert_eq!(super::super::installed(&dir).map(|(id, _)| id), Some("full"));

        remove(&dir).unwrap();
        assert_eq!(left(&dir), Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
