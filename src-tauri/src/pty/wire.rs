use std::io::{self, Read, Write};

// Input and output share one stream, so a keystroke is never reordered
// against the bytes it answers.
pub const ATTACH_METHOD: &str = "pty.attach";

pub const DATA: u8 = 0;
pub const RESIZE: u8 = 1;
pub const EXIT: u8 = 2;

// A paste is one frame, and only a local client gets this far.
const MAX_FRAME: usize = 64 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachParams {
    pub token: String,
    pub tab: String,
    pub replay: bool,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spawn {
    pub tab: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub kind: String,
    pub init: Option<String>,
    pub quiet_ms: Option<u64>,
    // Last, so a caller pointing an agent at another home wins.
    pub env: Vec<(String, String)>,
    pub agent: Option<String>,
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Listed {
    pub tab: String,
    pub agent: Option<String>,
    pub profile: Option<String>,
    pub cwd: String,
    pub busy: bool,
    // The shell has handed the terminal to a program, an agent it started.
    #[serde(default)]
    pub handed_on: bool,
}

pub fn write_frame(out: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..].copy_from_slice(&len.to_be_bytes());
    out.write_all(&head)?;
    out.write_all(payload)?;
    out.flush()
}

pub fn read_frame(input: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match input.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "attach frame too long"));
    }
    let mut payload = vec![0u8; len];
    input.read_exact(&mut payload)?;
    Ok(Some((head[0], payload)))
}

pub fn resize(cols: u16, rows: u16) -> Vec<u8> {
    let mut payload = cols.to_be_bytes().to_vec();
    payload.extend_from_slice(&rows.to_be_bytes());
    payload
}

pub fn parse_resize(payload: &[u8]) -> Option<(u16, u16)> {
    let [c0, c1, r0, r1] = payload else { return None };
    Some((u16::from_be_bytes([*c0, *c1]), u16::from_be_bytes([*r0, *r1])))
}

pub fn exit(code: Option<u32>) -> Vec<u8> {
    match code {
        Some(code) => [&[1u8][..], &code.to_be_bytes()].concat(),
        None => vec![0],
    }
}

pub fn parse_exit(payload: &[u8]) -> Option<u32> {
    match payload {
        [1, a, b, c, d] => Some(u32::from_be_bytes([*a, *b, *c, *d])),
        _ => None,
    }
}
