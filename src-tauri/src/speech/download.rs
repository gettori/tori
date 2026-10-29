use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::dictation::{moonshine, parakeet};

const KOKORO: &str =
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const KITTEN: &str =
    "https://huggingface.co/KittenML/kitten-tts-nano-0.8-fp32/resolve/7a1db645b1f3ab9420761d87428e042b9cec3f26";
const MOONSHINE: &str =
    "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad";
const PARAKEET: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/0bbb45a3365852604aef28b538a8f066f4ccaa85";

const KITTEN_VOICES: (&str, u64) = (
    "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f",
    3_278_902,
);

pub const CANCELLED: &str = "cancelled";

pub struct Size {
    pub id: &'static str,
    pub file: &'static str,
    sha256: &'static str,
    bytes: u64,
}

impl Size {
    fn kitten(&self) -> bool {
        self.id == "fast"
    }
}

pub struct Set {
    pub sizes: &'static [Size],
    manifest: fn(&Size) -> Vec<Pinned>,
    install_files: fn(&Size) -> Vec<&'static str>,
    subdirs: &'static [&'static str],
}

pub static VOICE: Set = Set {
    sizes: &SIZES,
    manifest: voice_manifest,
    install_files: voice_files,
    subdirs: &["voices"],
};

pub static DICTATION: Set = Set {
    sizes: &DICTATION_SIZES,
    manifest: dictation_manifest,
    install_files: dictation_files,
    subdirs: &[],
};

pub const SIZES: [Size; 3] = [
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
    Size {
        id: "fast",
        file: super::kitten::MODEL,
        sha256: "320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e",
        bytes: 56_767_095,
    },
];

const TOKENIZER: (&str, u64) = (
    "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    3_497,
);

pub const DICTATION_SIZES: [Size; 2] = [
    Size {
        id: "moonshine",
        file: moonshine::ENCODER,
        sha256: "1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751",
        bytes: 20_513_063,
    },
    Size {
        id: "parakeet",
        file: parakeet::ENCODER,
        sha256: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155",
        bytes: 652_184_014,
    },
];

struct Companion {
    path: &'static str,
    repo_path: &'static str,
    sha256: &'static str,
    bytes: u64,
}

const MOONSHINE_FILES: [Companion; 2] = [
    Companion {
        path: moonshine::DECODER,
        repo_path: "onnx/decoder_model_merged_quantized.onnx",
        sha256: "cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3",
        bytes: 42_498_870,
    },
    Companion {
        path: moonshine::TOKENIZER,
        repo_path: "tokenizer.json",
        sha256: "7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f",
        bytes: 3_761_754,
    },
];

const PARAKEET_FILES: [Companion; 3] = [
    Companion {
        path: parakeet::DECODER,
        repo_path: parakeet::DECODER,
        sha256: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3",
        bytes: 8_998_286,
    },
    Companion {
        path: parakeet::FEATURES,
        repo_path: parakeet::FEATURES,
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
        bytes: 139_764,
    },
    Companion {
        path: parakeet::VOCAB,
        repo_path: parakeet::VOCAB,
        sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
        bytes: 9_384,
    },
];

fn companions(size: &Size) -> &'static [Companion] {
    if size.id == "moonshine" {
        &MOONSHINE_FILES
    } else {
        &PARAKEET_FILES
    }
}

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

fn pinned(base: &str, path: String, from: &str, sha256: &str, bytes: u64) -> Pinned {
    Pinned {
        path,
        url: format!("{base}/{from}"),
        sha256: sha256.into(),
        bytes,
    }
}

fn voice_manifest(model: &Size) -> Vec<Pinned> {
    if model.kitten() {
        return vec![
            pinned(
                KITTEN,
                super::kitten::VOICES_FILE.into(),
                super::kitten::VOICES_FILE,
                KITTEN_VOICES.0,
                KITTEN_VOICES.1,
            ),
            pinned(KITTEN, model.file.into(), model.file, model.sha256, model.bytes),
        ];
    }
    let mut files = vec![pinned(
        KOKORO,
        "tokenizer.json".into(),
        "tokenizer.json",
        TOKENIZER.0,
        TOKENIZER.1,
    )];
    files.extend(VOICES.iter().map(|(name, sha)| {
        let path = format!("voices/{name}.bin");
        pinned(KOKORO, path.clone(), &path, sha, VOICE_BYTES)
    }));
    files.push(pinned(
        KOKORO,
        model.file.into(),
        &format!("onnx/{}", model.file),
        model.sha256,
        model.bytes,
    ));
    files
}

fn voice_files(size: &Size) -> Vec<&'static str> {
    if size.kitten() {
        vec![size.file, super::kitten::VOICES_FILE]
    } else {
        vec!["tokenizer.json", size.file]
    }
}

fn dictation_manifest(model: &Size) -> Vec<Pinned> {
    let (base, from) = if model.id == "moonshine" {
        (MOONSHINE, format!("onnx/{}", model.file))
    } else {
        (PARAKEET, model.file.into())
    };
    let mut files: Vec<Pinned> = companions(model)
        .iter()
        .map(|c| pinned(base, c.path.into(), c.repo_path, c.sha256, c.bytes))
        .collect();
    files.push(pinned(base, model.file.into(), &from, model.sha256, model.bytes));
    files
}

fn dictation_files(size: &Size) -> Vec<&'static str> {
    let mut files: Vec<&'static str> = companions(size).iter().map(|c| c.path).collect();
    files.push(size.file);
    files
}

impl Set {
    pub fn size(&self, id: &str) -> Option<&'static Size> {
        self.sizes.iter().find(|s| s.id == id)
    }

    pub fn manifest(&self, id: &str) -> Option<Vec<Pinned>> {
        self.size(id).map(self.manifest)
    }

    pub fn installed(&self, dir: &Path) -> Option<&'static Size> {
        self.sizes
            .iter()
            .find(|s| (self.install_files)(s).iter().all(|f| dir.join(f).is_file()))
    }

    pub fn install(
        &self,
        dir: &Path,
        files: &[Pinned],
        fetch: Fetch,
        cancelled: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String> {
        let staging = dir.join(".download");
        let _ = std::fs::remove_dir_all(&staging);
        let result =
            fill(&staging, files, fetch, cancelled, progress).and_then(|()| self.swap_in(dir, &staging, files));
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    fn is_model(&self, path: &str) -> bool {
        self.sizes.iter().any(|s| s.file == path)
    }

    // The model goes in last: its presence is what counts as installed, so a move
    // that fails partway never looks like a finished download.
    fn swap_in(&self, dir: &Path, staging: &Path, files: &[Pinned]) -> Result<(), String> {
        let (models, rest): (Vec<&Pinned>, Vec<&Pinned>) = files.iter().partition(|f| self.is_model(&f.path));
        for f in rest.into_iter().chain(models) {
            let to = dir.join(&f.path);
            std::fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::rename(staging.join(&f.path), &to)
                .map_err(|e| format!("cannot move {} into place: {e}", f.path))?;
        }
        for other in self.every_file() {
            if !files.iter().any(|f| f.path == other) {
                remove_file(&dir.join(&other))?;
            }
        }
        Ok(())
    }

    fn every_file(&self) -> Vec<String> {
        let mut all: Vec<String> = self
            .sizes
            .iter()
            .flat_map(|s| (self.manifest)(s))
            .map(|f| f.path)
            .collect();
        all.sort();
        all.dedup();
        all
    }

    pub fn remove(&self, dir: &Path) -> Result<(), String> {
        for file in self.every_file() {
            remove_file(&dir.join(file))?;
        }
        for sub in self.subdirs {
            match std::fs::remove_dir_all(dir.join(sub)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        }
        Ok(())
    }
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
        let size = SIZES.iter().find(|s| s.id == size).unwrap();
        if size.kitten() {
            return vec![file("voices.npz", &[3; 200]), file(size.file, &[4; 500])];
        }
        vec![
            file("tokenizer.json", b"{}"),
            file("voices/af_heart.bin", &[1; 300]),
            file(size.file, &[2; 500]),
        ]
    }

    fn dictation_model(size: &str) -> Vec<(Pinned, Vec<u8>)> {
        let size = DICTATION.size(size).unwrap();
        let mut files: Vec<(Pinned, Vec<u8>)> = dictation_files(size)
            .iter()
            .take_while(|f| **f != size.file)
            .enumerate()
            .map(|(i, f)| file(f, &[i as u8; 100]))
            .collect();
        files.push(file(size.file, &[9; 500]));
        files
    }

    fn run(dir: &Path, files: &[(Pinned, Vec<u8>)], cancelled: &dyn Fn() -> bool) -> Result<Vec<(u64, u64)>, String> {
        run_set(&VOICE, dir, files, cancelled)
    }

    fn run_set(
        set: &Set,
        dir: &Path,
        files: &[(Pinned, Vec<u8>)],
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<(u64, u64)>, String> {
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
        set.install(dir, &pinned, &fetch, cancelled, &mut |d, t| seen.push((d, t)))?;
        Ok(seen)
    }

    fn installed(dir: &Path) -> bool {
        VOICE.installed(dir).is_some()
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
            let files = VOICE.manifest(size.id).unwrap();
            let model = files.last().unwrap();
            assert_eq!(model.path, size.file);
            assert_eq!(model.sha256, size.sha256);
            if size.kitten() {
                assert!(model.url.ends_with(&format!("/{}", size.file)));
                assert_eq!(files[0].path, "voices.npz");
                assert_eq!(files.len(), 2);
                continue;
            }
            assert!(model.url.ends_with(&format!("/onnx/{}", size.file)));
            assert!(files.iter().any(|f| f.path == "tokenizer.json"));
            assert_eq!(files.iter().filter(|f| f.path.starts_with("voices/")).count(), 28);
        }
        assert!(VOICE.manifest("half").is_none());
    }

    #[test]
    fn each_dictation_model_fetches_its_own_files_against_their_hashes() {
        let moonshine = DICTATION.manifest("moonshine").unwrap();
        let paths: Vec<&str> = moonshine.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "decoder_model_merged_quantized.onnx",
                "tokenizer.json",
                "encoder_model_quantized.onnx"
            ]
        );
        assert!(moonshine[0].url.ends_with("/onnx/decoder_model_merged_quantized.onnx"));
        assert!(moonshine[1]
            .url
            .ends_with("b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad/tokenizer.json"));
        assert!(moonshine[2].url.ends_with("/onnx/encoder_model_quantized.onnx"));
        assert_eq!(moonshine.iter().map(|f| f.bytes).sum::<u64>(), 66_773_687);

        let parakeet = DICTATION.manifest("parakeet").unwrap();
        let paths: Vec<&str> = parakeet.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "decoder_joint-model.int8.onnx",
                "nemo128.onnx",
                "vocab.txt",
                "encoder-model.int8.onnx"
            ]
        );
        assert!(parakeet.iter().all(|f| f.url == format!("{PARAKEET}/{}", f.path)));
        assert_eq!(parakeet.iter().map(|f| f.bytes).sum::<u64>(), 661_331_448);
        for f in moonshine.iter().chain(&parakeet) {
            assert_eq!(f.sha256.len(), 64, "{}", f.path);
        }
        assert!(DICTATION.manifest("whisper").is_none());
    }

    #[test]
    fn a_bad_hash_leaves_no_file() {
        for size in &SIZES {
            let dir = temp_dir("bad_hash");
            let mut files = model(size.id);
            files.last_mut().unwrap().0.sha256 = "0".repeat(64);
            let err = run(&dir, &files, &|| false).unwrap_err();
            assert_eq!(err, format!("{}: checksum mismatch", size.file));
            assert_eq!(left(&dir), Vec::<String>::new());
            std::fs::remove_dir_all(&dir).unwrap();
        }
        for size in &DICTATION_SIZES {
            let dir = temp_dir("bad_dictation_hash");
            let mut files = dictation_model(size.id);
            files.last_mut().unwrap().0.sha256 = "0".repeat(64);
            let err = run_set(&DICTATION, &dir, &files, &|| false).unwrap_err();
            assert_eq!(err, format!("{}: checksum mismatch", size.file));
            assert_eq!(left(&dir), Vec::<String>::new());
            assert!(DICTATION.installed(&dir).is_none());
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
        let err = VOICE
            .install(&dir, &pinned, &fetch, &|| false, &mut |_, _| {})
            .unwrap_err();
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
        assert_eq!(VOICE.installed(&dir).map(|s| s.id), Some("full"));
        run(&dir, &model("fast"), &|| false).unwrap();
        assert_eq!(left(&dir), [super::super::kitten::MODEL, "voices.npz"]);
        assert_eq!(VOICE.installed(&dir).map(|s| s.id), Some("fast"));
        run(&dir, &model("int8"), &|| false).unwrap();
        assert_eq!(
            left(&dir),
            ["model_quantized.onnx", "tokenizer.json", "voices/af_heart.bin"]
        );

        VOICE.remove(&dir).unwrap();
        assert_eq!(left(&dir), Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn switching_dictation_model_leaves_only_the_new_one() {
        let dir = temp_dir("switch_dictation");
        run_set(&DICTATION, &dir, &dictation_model("moonshine"), &|| false).unwrap();
        assert_eq!(
            left(&dir),
            [
                "decoder_model_merged_quantized.onnx",
                "encoder_model_quantized.onnx",
                "tokenizer.json"
            ]
        );
        assert_eq!(DICTATION.installed(&dir).map(|s| s.id), Some("moonshine"));
        run_set(&DICTATION, &dir, &dictation_model("parakeet"), &|| false).unwrap();
        assert_eq!(
            left(&dir),
            [
                "decoder_joint-model.int8.onnx",
                "encoder-model.int8.onnx",
                "nemo128.onnx",
                "vocab.txt"
            ]
        );
        assert_eq!(DICTATION.installed(&dir).map(|s| s.id), Some("parakeet"));
        run_set(&DICTATION, &dir, &dictation_model("moonshine"), &|| false).unwrap();
        assert_eq!(DICTATION.installed(&dir).map(|s| s.id), Some("moonshine"));

        DICTATION.remove(&dir).unwrap();
        assert_eq!(left(&dir), Vec::<String>::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_voice_and_a_dictation_model_download_at_once_into_their_own_folders() {
        let voice_dir = temp_dir("both_voice");
        let dictation_dir = temp_dir("both_dictation");
        let (a, b) = (voice_dir.clone(), dictation_dir.clone());
        let voice = std::thread::spawn(move || run(&a, &model("int8"), &|| false));
        let dictation = std::thread::spawn(move || run_set(&DICTATION, &b, &dictation_model("moonshine"), &|| false));
        voice.join().unwrap().unwrap();
        dictation.join().unwrap().unwrap();
        assert_eq!(VOICE.installed(&voice_dir).map(|s| s.id), Some("int8"));
        assert_eq!(DICTATION.installed(&dictation_dir).map(|s| s.id), Some("moonshine"));
        assert_eq!(left(&voice_dir).len(), 3);
        assert_eq!(left(&dictation_dir).len(), 3);
        std::fs::remove_dir_all(&voice_dir).unwrap();
        std::fs::remove_dir_all(&dictation_dir).unwrap();
    }
}
