//! `attachment.write`: a file the browser sends in base64 chunks, since one
//! socket frame holds 256 KB.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use super::frame::{RpcError, INVALID_PARAMS, REFUSED};
use super::server::AttachmentWriteParams;

/// Encoded, so a chunk and its envelope stay inside one frame.
pub const CHUNK_MAX: usize = 192 * 1024;
pub const FILE_MAX: usize = 8 * 1024 * 1024;
pub const ABANDONED: Duration = Duration::from_secs(60);

struct Upload {
    name: String,
    bytes: Vec<u8>,
    touched: Instant,
}

pub struct Uploads {
    dir: PathBuf,
    abandoned: Duration,
    open: Mutex<HashMap<String, Upload>>,
    next: Mutex<u64>,
}

impl Uploads {
    pub fn new(dir: PathBuf, abandoned: Duration) -> Self {
        Self {
            dir,
            abandoned,
            open: Mutex::default(),
            next: Mutex::default(),
        }
    }

    pub fn write(&self, params: AttachmentWriteParams) -> Result<Value, RpcError> {
        if params.data.len() > CHUNK_MAX {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("a chunk is at most {CHUNK_MAX} bytes of base64"),
            ));
        }
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(&params.data)
            .map_err(|e| RpcError::new(INVALID_PARAMS, format!("data: {e}")))?;
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        open.retain(|_, u| u.touched.elapsed() < self.abandoned);
        let (id, mut upload) = match params.upload {
            Some(id) => {
                let upload = open
                    .remove(&id)
                    .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no upload {id}, or it was abandoned")))?;
                (id, upload)
            }
            None => (
                self.next_id(),
                Upload {
                    name: params.name,
                    bytes: Vec::new(),
                    touched: Instant::now(),
                },
            ),
        };
        if upload.bytes.len() + chunk.len() > FILE_MAX {
            return Err(RpcError::new(
                REFUSED,
                format!("an attachment is at most {FILE_MAX} bytes"),
            ));
        }
        upload.bytes.extend_from_slice(&chunk);
        upload.touched = Instant::now();
        if params.last {
            let path = crate::attachments::store_in(&self.dir, &upload.name, &upload.bytes)
                .map_err(|e| RpcError::new(REFUSED, e))?;
            return Ok(json!({ "path": path }));
        }
        open.insert(id.clone(), upload);
        Ok(json!({ "upload": id }))
    }

    fn next_id(&self) -> String {
        let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        *next += 1;
        format!("u{next}")
    }

    #[cfg(test)]
    fn open_count(&self) -> usize {
        self.open.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn chunk(upload: Option<&str>, data: &[u8], last: bool) -> AttachmentWriteParams {
        AttachmentWriteParams {
            name: "shot.png".into(),
            data: b64(data),
            upload: upload.map(String::from),
            last,
        }
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-uploads-{}-{:?}", std::process::id(), Instant::now()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn three_chunks_land_as_one_file_under_its_name() {
        let uploads = Uploads::new(scratch(), ABANDONED);
        let id = uploads.write(chunk(None, b"one ", false)).unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_string();
        uploads.write(chunk(Some(&id), b"two ", false)).unwrap();
        let path = uploads.write(chunk(Some(&id), b"three", true)).unwrap()["path"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(path.ends_with("/shot.png"));
        assert_eq!(std::fs::read(&path).unwrap(), b"one two three");
        assert_eq!(uploads.open_count(), 0);
    }

    #[test]
    fn a_file_past_the_cap_is_refused() {
        let uploads = Uploads::new(scratch(), ABANDONED);
        let big = vec![0u8; CHUNK_MAX * 3 / 4];
        let id = uploads.write(chunk(None, &big, false)).unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_string();
        let refused = (0..FILE_MAX / big.len() + 1)
            .map(|_| uploads.write(chunk(Some(&id), &big, false)))
            .find_map(Result::err)
            .expect("the cap refuses a chunk");
        assert!(refused.message.contains("at most"), "{}", refused.message);
    }

    #[test]
    fn a_chunk_past_the_frame_budget_is_refused() {
        let uploads = Uploads::new(scratch(), ABANDONED);
        let refused = uploads.write(chunk(None, &vec![0u8; CHUNK_MAX], true)).unwrap_err();
        assert_eq!(refused.code, INVALID_PARAMS);
    }

    #[test]
    fn an_abandoned_upload_is_dropped() {
        let uploads = Uploads::new(scratch(), Duration::from_millis(20));
        let id = uploads.write(chunk(None, b"half", false)).unwrap()["upload"]
            .as_str()
            .unwrap()
            .to_string();
        std::thread::sleep(Duration::from_millis(40));
        let gone = uploads.write(chunk(Some(&id), b"rest", true)).unwrap_err();
        assert!(gone.message.contains("abandoned"), "{}", gone.message);
        assert_eq!(uploads.open_count(), 0);
    }
}
