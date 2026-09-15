//! The transport seam, and the two pagination walkers built on it.
//!
//! Every forge HTTP call goes through [`Transport`]. The GitHub client holds a
//! `&dyn Transport` rather than reaching for `ureq` directly, which is what
//! makes the whole provider testable with no network: a test double satisfies
//! the trait and the real mapping code runs against canned bytes.
//!
//! Blocking on purpose. `ureq` is already this codebase's HTTP client
//! (`model.rs`, `update.rs`), and every caller here is a plain `fn` that Tauri
//! runs off the async runtime, so there is nothing to starve.
//!
//! ## Two walkers, not one
//!
//! Pagination lives here so no call site does it by hand, but it genuinely
//! needs two implementations. REST pages by an opaque `Link` header; GraphQL
//! pages by `pageInfo`/`endCursor` cursors, and its connections **nest**, so a
//! correctly paged list of threads still hands back only the first page of each
//! thread's comments. One walker cannot cover both, and pretending otherwise is
//! how the nested case silently truncates.

use super::model::RateSnapshot;
use super::{ForgeError, RateLimitKind};
use serde_json::Value;

/// What replaces a credential in any human-readable rendering.
const REDACTED: &str = "<redacted>";

/// Body fields that carry a credential.
///
/// The device flow puts the real prize in a *response* body: the token exchange
/// answers with `access_token`, so redacting only the request's `Authorization`
/// header would still hand the token to the first person who prints a response.
const SECRET_KEYS: [&str; 4] = ["access_token", "refresh_token", "device_code", "client_secret"];

/// A request, as the transport needs it.
///
/// `Debug` is hand-written, not derived. See the impl below.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    /// Includes `Authorization` when signed in.
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Masks the values of [`SECRET_KEYS`] wherever they appear, leaving everything
/// else readable.
///
/// Redacting the *value* and keeping the *key* is deliberate: a body rendered as
/// an opaque blob is useless for triage, while `"access_token": "<redacted>"`
/// still tells you the exchange succeeded.
fn redact_body(body: &str) -> String {
    if let Ok(mut v) = serde_json::from_str::<Value>(body) {
        redact_value(&mut v);
        return v.to_string();
    }
    // The device-flow endpoints accept and (without an explicit Accept header)
    // answer form-encoded, so JSON is not the only shape a secret arrives in.
    body.split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) if SECRET_KEYS.contains(&k) => format!("{k}={REDACTED}"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn redact_value(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if SECRET_KEYS.contains(&k.as_str()) {
                    *val = Value::String(REDACTED.into());
                } else {
                    redact_value(val);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        _ => {}
    }
}

fn redact_headers(headers: &[(String, String)]) -> Vec<(&str, &str)> {
    headers
        .iter()
        .map(|(k, v)| {
            let value = if k.eq_ignore_ascii_case("authorization") { REDACTED } else { v.as_str() };
            (k.as_str(), value)
        })
        .collect()
}

/// Redacting `Debug`, so a credential cannot ride into a log line, a panic
/// message, or a forge error that reaches a toast.
///
/// A derived `Debug` prints the `Authorization` header verbatim, and the paths
/// that print one of these are exactly the paths a user is asked to copy into a
/// bug report. The URL and every other header stay intact, because none of them
/// is a secret and all of them are what you actually need to read.
impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &redact_headers(&self.headers))
            .field("body", &self.body.as_deref().map(redact_body))
            .finish()
    }
}

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("headers", &redact_headers(&self.headers))
            .field("body", &redact_body(&self.body))
            .finish()
    }
}

impl HttpResponse {
    /// Case-insensitive header lookup, because HTTP header names are
    /// case-insensitive and both `ureq` and a test double will disagree about
    /// the casing they hand back.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// The seam. One method, deliberately: anything richer would let a provider
/// depend on transport behaviour that a test double cannot reproduce.
pub trait Transport: Send + Sync {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError>;
}

/// The real one.
pub struct UreqTransport {
    timeout: std::time::Duration,
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self { timeout: std::time::Duration::from_secs(15) }
    }
}

impl Transport for UreqTransport {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError> {
        let mut r = ureq::request(req.method, &req.url).timeout(self.timeout);
        for (k, v) in &req.headers {
            r = r.set(k, v);
        }
        let result = match &req.body {
            Some(b) => r.send_string(b),
            None => r.call(),
        };
        // `ureq` treats any non-2xx as an `Err`, but a 401 or a 429 is a
        // response we very much want to read: the status and the headers are
        // the whole signal. Only a genuine transport failure is an error here.
        let resp = match result {
            Ok(resp) => resp,
            Err(ureq::Error::Status(_, resp)) => resp,
            Err(e) => return Err(ForgeError::Transport { message: e.to_string() }),
        };
        let status = resp.status();
        let headers = resp
            .headers_names()
            .into_iter()
            .filter_map(|n| resp.header(&n).map(|v| (n.clone(), v.to_string())))
            .collect();
        let body = resp
            .into_string()
            .map_err(|e| ForgeError::Transport { message: e.to_string() })?;
        Ok(HttpResponse { status, headers, body })
    }
}

/// Wraps a transport and records what every response said about the rate budget
/// and the credential.
///
/// A transport rather than a method on a provider: the pagination walkers take a
/// `&dyn Transport` and loop on it directly, so anything that lived in a
/// provider method would be skipped by every paginated call. Here a 401 on page
/// three of a walk marks the credential suspect exactly like a 401 on a single
/// GET, with no call site able to opt out.
pub struct Recording {
    inner: Box<dyn Transport>,
    /// Set once a 401 has been seen. The token is kept, not cleared: see
    /// [`super::model::AuthState::Suspect`].
    suspect: std::sync::atomic::AtomicBool,
    rate: std::sync::Mutex<RateSnapshot>,
}

impl Recording {
    pub fn new(inner: Box<dyn Transport>) -> Self {
        Self {
            inner,
            suspect: std::sync::atomic::AtomicBool::new(false),
            rate: std::sync::Mutex::new(RateSnapshot::default()),
        }
    }

    pub fn rate(&self) -> RateSnapshot {
        *self.rate.lock().unwrap()
    }

    pub fn suspect(&self) -> bool {
        self.suspect.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl Transport for Recording {
    fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError> {
        let resp = self.inner.send(req)?;
        *self.rate.lock().unwrap() = rate_snapshot(&resp);
        match resp.status {
            401 => self.suspect.store(true, std::sync::atomic::Ordering::Relaxed),
            // Any answered call clears the suspicion. A 401 from a proxy, a
            // captive portal or a forge incident is transient, and without this
            // the flag would latch on forever: the user would be told to sign in
            // again to fix something that had already fixed itself.
            200..=299 => self.suspect.store(false, std::sync::atomic::Ordering::Relaxed),
            _ => {}
        }
        Ok(resp)
    }
}

/// How many pages either walker will follow before giving up and reporting
/// truncation.
///
/// A cap rather than an unbounded loop: a paging bug on either side would
/// otherwise spend the whole rate budget in one call. Reported, never silent.
pub const PAGE_CAP: usize = 20;

/// What a response said about the rate budget, in either spelling.
///
/// GitHub prefixes the headers with `X-`, GitLab sends the RFC names. Both are
/// read in one place so the classifier and the recording transport cannot end
/// up disagreeing about which budget a response reported.
pub fn rate_snapshot(resp: &HttpResponse) -> RateSnapshot {
    let field = |names: [&str; 2]| {
        names.iter().find_map(|n| resp.header(n)).map(str::trim).filter(|v| !v.is_empty())
    };
    RateSnapshot {
        remaining: field(["X-RateLimit-Remaining", "RateLimit-Remaining"])
            .and_then(|v| v.parse().ok()),
        limit: field(["X-RateLimit-Limit", "RateLimit-Limit"]).and_then(|v| v.parse().ok()),
        reset_at: field(["X-RateLimit-Reset", "RateLimit-Reset"]).and_then(|v| v.parse().ok()),
    }
}

/// Maps a non-2xx response onto the variant a caller can branch on.
///
/// The interesting split is the two rate limits. A primary limit is the hourly
/// budget and arrives as a 403 with `X-RateLimit-Remaining: 0`; a secondary
/// limit is the anti-abuse throttle and arrives as a 429 (sometimes a 403) with
/// `Retry-After`. A client that recognises only the 403 hammers straight
/// through every 429, which is the exact behaviour that earns a longer block.
pub fn classify(resp: &HttpResponse) -> Option<ForgeError> {
    if (200..300).contains(&resp.status) {
        return None;
    }
    let message = error_message(&resp.body).unwrap_or_else(|| resp.body.clone());
    let retry_after = resp.header("Retry-After").and_then(|v| v.trim().parse::<u64>().ok());
    // Read here rather than left to the caller's rate snapshot: a refusal is
    // exactly the response whose body never reaches the snapshot's reader, so
    // the one number that says when to come back would be dropped on the only
    // path that needs it.
    let rate = rate_snapshot(resp);
    let exhausted = rate.remaining == Some(0);
    let reset_at = rate.reset_at;

    Some(match resp.status {
        401 => ForgeError::CredentialSuspect,
        403 if exhausted => ForgeError::RateLimited {
            kind: RateLimitKind::Primary,
            retry_after_secs: retry_after,
            reset_at_secs: reset_at,
        },
        // A 403 carrying `Retry-After` is the secondary limit wearing the
        // forbidden status code, which is why the retry header is checked
        // before falling through to a permissions error.
        403 if retry_after.is_some() => ForgeError::RateLimited {
            kind: RateLimitKind::Secondary,
            retry_after_secs: retry_after,
            reset_at_secs: reset_at,
        },
        403 => ForgeError::Forbidden { message },
        404 => ForgeError::NotFound,
        405 => ForgeError::NotMergeable { message },
        // 422 is GitHub's catch-all validation status, not an "already exists"
        // status. Creating a PR with nothing to merge, or from a head the server
        // cannot see, lands here too, and reporting those as "a PR already
        // exists" sends the user looking for a PR that is not there.
        422 if message.to_ascii_lowercase().contains("already exists") => {
            ForgeError::AlreadyExists { message }
        }
        422 => ForgeError::Api { status: 422, message },
        429 => ForgeError::RateLimited {
            kind: RateLimitKind::Secondary,
            retry_after_secs: retry_after,
            reset_at_secs: reset_at,
        },
        status => ForgeError::Api { status, message },
    })
}

/// GitHub's error bodies put the human-readable part in `message`. Falling back
/// to the raw body keeps an unexpected shape debuggable instead of blank.
/// The sentence to show, folding in the per-field detail.
///
/// A 422's top-level `message` is always the literal "Validation Failed", which
/// names no field and suggests no fix. Everything actionable ("A pull request
/// already exists for owner:branch", "No commits between main and wave-3") is in
/// the `errors` array, so both are joined rather than only the first read.
fn error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let top = v.get("message")?.as_str()?.to_string();
    let details: Vec<String> = v
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|errs| {
            errs.iter().filter_map(|e| e.get("message")?.as_str()).map(|s| s.to_string()).collect()
        })
        .unwrap_or_default();
    if details.is_empty() {
        return Some(top);
    }
    Some(format!("{top}: {}", details.join("; ")))
}

/// The `url` of the `rel="next"` link, if the header offers one.
///
/// Parsed rather than constructed: the cursor GitHub embeds is opaque and
/// rebuilding the URL by incrementing a `page=` query parameter breaks the
/// moment an endpoint switches to cursor paging (several already have).
pub fn parse_link_next(header: &str) -> Option<String> {
    for part in header.split(',') {
        let mut bits = part.splitn(2, ';');
        let url = bits.next()?.trim();
        let rest = bits.next().unwrap_or("");
        if !rest.contains("rel=\"next\"") {
            continue;
        }
        let url = url.strip_prefix('<')?.strip_suffix('>')?;
        return Some(url.to_string());
    }
    None
}

/// Follows `Link: rel="next"` until it runs out or hits [`PAGE_CAP`].
///
/// Returns the concatenated JSON arrays plus whether the cap cut it short. The
/// caller gets a truncation flag rather than a short list, because a partial
/// list that renders as a complete one is the failure nobody notices.
pub fn paginate_rest(
    transport: &dyn Transport,
    first: HttpRequest,
    cap: usize,
) -> Result<(Vec<Value>, bool), ForgeError> {
    let mut out = Vec::new();
    let mut req = first;
    for _ in 0..cap {
        let resp = transport.send(req.clone())?;
        if let Some(err) = classify(&resp) {
            return Err(err);
        }
        let page: Value = serde_json::from_str(&resp.body)
            .map_err(|e| ForgeError::Malformed { message: e.to_string() })?;
        match page {
            Value::Array(items) => out.extend(items),
            // Some list endpoints wrap the array (the Checks API returns
            // `{ total_count, check_runs: [...] }`). Requiring exactly one array
            // field rather than taking the first: `serde_json`'s map is sorted,
            // so "first" would be a stable but arbitrary pick, and a response
            // with two arrays would silently page the wrong one.
            Value::Object(ref map) => {
                let mut arrays = map.values().filter(|v| v.is_array());
                match (arrays.next(), arrays.next()) {
                    (Some(Value::Array(items)), None) => out.extend(items.clone()),
                    (None, _) => {
                        return Err(ForgeError::Malformed {
                            message: "paged response had no array field".into(),
                        })
                    }
                    _ => {
                        return Err(ForgeError::Malformed {
                            message: "paged response had more than one array field".into(),
                        })
                    }
                }
            }
            _ => {
                return Err(ForgeError::Malformed {
                    message: "paged response was neither array nor object".into(),
                })
            }
        }

        match resp.header("Link").and_then(parse_link_next) {
            Some(next) => req.url = next,
            None => return Ok((out, false)),
        }
    }
    Ok((out, true))
}

/// Where a connection lives in a GraphQL response, and the variable that
/// advances it.
#[derive(Debug, Clone)]
pub struct ConnectionSpec {
    /// Keys from the response root (below `data`) down to the connection
    /// object, e.g. `["repository", "pullRequest", "reviewThreads"]`.
    pub path: Vec<String>,
    /// The query variable carrying this connection's `after:` cursor.
    pub cursor_var: String,
}

/// A connection hanging off each node of an outer connection.
///
/// Its own type because the nested case needs a *different* query: you cannot
/// advance an inner cursor from the outer query without re-paging the outer
/// connection too. The follow-up query is issued per node that has more.
#[derive(Debug, Clone)]
pub struct NestedSpec {
    /// The key on each outer node holding the inner connection.
    pub key: String,
    /// The query used to fetch further pages of one node's inner connection.
    pub query: String,
    /// The variable carrying the owning node's id in that follow-up query.
    pub id_var: String,
    /// The variable carrying the inner `after:` cursor.
    pub cursor_var: String,
    /// Where the inner connection sits in the follow-up response, below `data`.
    pub path: Vec<String>,
}

fn dig<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut cur = root;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

/// Where a GraphQL query goes, bundled because the three travel together
/// everywhere and are the caller's own state, not per-call arguments.
pub struct GraphqlEndpoint<'a> {
    pub transport: &'a dyn Transport,
    pub url: &'a str,
    pub headers: &'a [(String, String)],
}

impl GraphqlEndpoint<'_> {
    fn post(&self, query: &str, vars: &Value) -> Result<HttpResponse, ForgeError> {
        self.transport.send(HttpRequest {
            method: "POST",
            url: self.url.to_string(),
            headers: self.headers.to_vec(),
            body: Some(serde_json::json!({ "query": query, "variables": vars }).to_string()),
        })
    }
}

/// A GraphQL response's `data`, or the error it carried instead.
///
/// GraphQL answers 200 with an `errors` array, so a status check alone would
/// read a failure as an empty page and page happily onward.
pub fn graphql_data(resp: &HttpResponse) -> Result<Value, ForgeError> {
    if let Some(err) = classify(resp) {
        return Err(err);
    }
    let v: Value = serde_json::from_str(&resp.body)
        .map_err(|e| ForgeError::Malformed { message: e.to_string() })?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        if !errors.is_empty() {
            let message = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            // A revoked or under-scoped token shows up here rather than as a
            // 401, so the credential states stay reachable through GraphQL too.
            if errors.iter().any(|e| {
                e.get("type").and_then(|t| t.as_str()) == Some("FORBIDDEN")
            }) {
                return Err(ForgeError::Forbidden { message });
            }
            return Err(ForgeError::Api { status: 200, message });
        }
    }
    v.get("data")
        .cloned()
        .ok_or_else(|| ForgeError::Malformed { message: "no data in GraphQL response".into() })
}

/// Walks an outer connection to exhaustion, then fills in every node's nested
/// connection that was itself cut short.
///
/// Returns the outer nodes with their inner `nodes` arrays completed in place,
/// plus whether [`PAGE_CAP`] cut anything short.
pub fn paginate_graphql(
    endpoint: &GraphqlEndpoint<'_>,
    query: &str,
    vars: &Value,
    outer: &ConnectionSpec,
    nested: Option<&NestedSpec>,
    cap: usize,
) -> Result<(Vec<Value>, bool), ForgeError> {
    let mut nodes: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut truncated = true;

    for _ in 0..cap {
        let mut v = vars.clone();
        v[&outer.cursor_var] = cursor.clone().map(Value::String).unwrap_or(Value::Null);
        let resp = endpoint.post(query, &v)?;
        let data = graphql_data(&resp)?;
        let conn = dig(&data, &outer.path).ok_or_else(|| ForgeError::Malformed {
            message: format!("no connection at {}", outer.path.join(".")),
        })?;
        if let Some(page) = conn.get("nodes").and_then(|n| n.as_array()) {
            nodes.extend(page.clone());
        }
        let info = conn.get("pageInfo");
        let has_next = info
            .and_then(|i| i.get("hasNextPage"))
            .and_then(|h| h.as_bool())
            .unwrap_or(false);
        if !has_next {
            truncated = false;
            break;
        }
        cursor = info
            .and_then(|i| i.get("endCursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
        // `hasNextPage` with no `endCursor` would loop on page one forever.
        if cursor.is_none() {
            break;
        }
    }

    if let Some(spec) = nested {
        for node in nodes.iter_mut() {
            if fill_nested(endpoint, spec, node, cap)? {
                truncated = true;
            }
        }
    }

    Ok((nodes, truncated))
}

/// Completes one node's inner connection, returning whether the cap cut it
/// short. A no-op when the first page already said `hasNextPage: false`, which
/// is the common case and costs nothing.
fn fill_nested(
    endpoint: &GraphqlEndpoint<'_>,
    spec: &NestedSpec,
    node: &mut Value,
    cap: usize,
) -> Result<bool, ForgeError> {
    let Some(conn) = node.get(&spec.key) else { return Ok(false) };
    let mut collected: Vec<Value> = conn
        .get("nodes")
        .and_then(|n| n.as_array())
        .cloned()
        .unwrap_or_default();
    let info = conn.get("pageInfo");
    let mut has_next =
        info.and_then(|i| i.get("hasNextPage")).and_then(|h| h.as_bool()).unwrap_or(false);
    let mut cursor = info
        .and_then(|i| i.get("endCursor"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let Some(id) = node.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()) else {
        // No id means no way to ask for more of this node specifically, so the
        // honest answer is "possibly truncated" rather than a silent stop.
        return Ok(has_next);
    };

    for _ in 0..cap {
        if !has_next {
            break;
        }
        // A `hasNextPage` with no cursor would re-request the same page until
        // the cap, so stop and let `has_next` report it as truncated.
        let Some(after) = cursor.clone() else { break };
        let vars = serde_json::json!({
            spec.id_var.clone(): id,
            spec.cursor_var.clone(): after,
        });
        let resp = endpoint.post(&spec.query, &vars)?;
        let data = graphql_data(&resp)?;
        let inner = dig(&data, &spec.path).ok_or_else(|| ForgeError::Malformed {
            message: format!("no nested connection at {}", spec.path.join(".")),
        })?;
        if let Some(page) = inner.get("nodes").and_then(|n| n.as_array()) {
            collected.extend(page.clone());
        }
        let info = inner.get("pageInfo");
        has_next =
            info.and_then(|i| i.get("hasNextPage")).and_then(|h| h.as_bool()).unwrap_or(false);
        cursor = info
            .and_then(|i| i.get("endCursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
    }

    node[&spec.key]["nodes"] = Value::Array(collected);
    // Read after the loop, not seeded before it: seeding meant hitting the cap
    // on the very page that finished paging still reported truncation.
    Ok(has_next)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Mutex;

    /// A scripted transport: hands back queued responses in order and records
    /// every request it was given.
    ///
    /// This is the whole point of the seam. The GitHub mapping code runs for
    /// real against these bytes, so a test proves the mapping, not a mock of it.
    pub struct StubTransport {
        queued: Mutex<std::collections::VecDeque<HttpResponse>>,
        pub seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        pub fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                queued: Mutex::new(responses.into_iter().collect()),
                seen: Mutex::new(Vec::new()),
            }
        }

        pub fn json(status: u16, body: &str) -> HttpResponse {
            HttpResponse { status, headers: vec![], body: body.to_string() }
        }

        pub fn with_headers(status: u16, headers: &[(&str, &str)], body: &str) -> HttpResponse {
            HttpResponse {
                status,
                headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                body: body.to_string(),
            }
        }

        pub fn request_count(&self) -> usize {
            self.seen.lock().unwrap().len()
        }
    }

    impl StubTransport {
        /// Every request the client actually sent, in order.
        pub fn requests(&self) -> Vec<HttpRequest> {
            self.seen.lock().unwrap().clone()
        }

        /// The request bodies, which is where a GraphQL document ends up.
        pub fn bodies(&self) -> Vec<String> {
            self.seen.lock().unwrap().iter().map(|r| r.body.clone().unwrap_or_default()).collect()
        }
    }

    impl Transport for StubTransport {
        fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError> {
            self.seen.lock().unwrap().push(req);
            self.queued
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ForgeError::Transport { message: "stub ran out of responses".into() })
        }
    }

    /// Lets a test keep a handle on the stub after handing ownership to the
    /// client. The alternative (reaching back through the `dyn Transport`) needs
    /// a pointer cast that is not sound for a trait object.
    impl Transport for std::sync::Arc<StubTransport> {
        fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError> {
            self.as_ref().send(req)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::StubTransport;
    use super::*;

    #[test]
    fn a_rate_limit_response_is_read_as_a_rate_limit_not_a_permission_error() {
        let primary = StubTransport::with_headers(
            403,
            &[("X-RateLimit-Remaining", "0"), ("X-RateLimit-Reset", "1785179400")],
            r#"{"message":"API rate limit exceeded"}"#,
        );
        assert_eq!(
            classify(&primary),
            Some(ForgeError::RateLimited {
                kind: RateLimitKind::Primary,
                retry_after_secs: None,
                // A 403 names no `Retry-After`, so the reset is the only thing
                // that says when to come back. Read off the refusal itself,
                // because a refusal is the one response whose rate snapshot the
                // caller never gets to see.
                reset_at_secs: Some(1_785_179_400),
            })
        );

        // The secondary limit is a 429 with a deadline, and it is the one a
        // 403-only reading would hammer straight through.
        let secondary = StubTransport::with_headers(
            429,
            &[("Retry-After", "60")],
            r#"{"message":"You have exceeded a secondary rate limit"}"#,
        );
        assert_eq!(
            classify(&secondary),
            Some(ForgeError::RateLimited {
                kind: RateLimitKind::Secondary,
                retry_after_secs: Some(60),
                reset_at_secs: None,
            })
        );

        // A plain 403 with neither signal is still a permissions problem.
        let forbidden = StubTransport::json(403, r#"{"message":"Resource not accessible"}"#);
        assert_eq!(
            classify(&forbidden),
            Some(ForgeError::Forbidden { message: "Resource not accessible".into() })
        );
    }

    #[test]
    fn a_rate_limit_reads_the_same_in_either_spelling() {
        // GitHub prefixes these headers with `X-`; GitLab sends the RFC names.
        // A reader that knew only one family would take the other's refusal for
        // a permissions error, and stop polling for the wrong reason with no
        // deadline to come back on.
        let throttled = StubTransport::with_headers(
            429,
            &[
                ("RateLimit-Remaining", "0"),
                ("RateLimit-Reset", "1785179400"),
                ("RateLimit-Limit", "2000"),
            ],
            r#"{"message":"Too many requests"}"#,
        );
        assert_eq!(
            classify(&throttled),
            Some(ForgeError::RateLimited {
                kind: RateLimitKind::Secondary,
                retry_after_secs: None,
                reset_at_secs: Some(1_785_179_400),
            })
        );

        // And a 403 with the budget gone is the primary limit in that spelling
        // too, not a permissions error.
        let exhausted = StubTransport::with_headers(
            403,
            &[("RateLimit-Remaining", "0"), ("RateLimit-Reset", "1785179400")],
            r#"{"message":"Rate limit exceeded"}"#,
        );
        assert!(matches!(
            classify(&exhausted),
            Some(ForgeError::RateLimited { kind: RateLimitKind::Primary, .. })
        ));

        // Both families feed the one snapshot the scheduler paces itself by.
        let snapshot = rate_snapshot(&throttled);
        assert_eq!(snapshot.remaining, Some(0));
        assert_eq!(snapshot.limit, Some(2000));
        assert_eq!(snapshot.reset_at, Some(1_785_179_400));
    }

    #[test]
    fn a_canned_error_body_keeps_its_message_and_status() {
        let resp = StubTransport::json(500, r#"{"message":"Server Error"}"#);
        assert_eq!(
            classify(&resp),
            Some(ForgeError::Api { status: 500, message: "Server Error".into() })
        );

        // An unparseable body still has to say something useful.
        let raw = StubTransport::json(502, "<html>bad gateway</html>");
        assert_eq!(
            classify(&raw),
            Some(ForgeError::Api { status: 502, message: "<html>bad gateway</html>".into() })
        );

        // A 401 never becomes a generic API error: it is the credential state.
        assert_eq!(
            classify(&StubTransport::json(401, r#"{"message":"Bad credentials"}"#)),
            Some(ForgeError::CredentialSuspect)
        );

        assert_eq!(classify(&StubTransport::json(200, "[]")), None);
    }

    /// The token must not survive into anything a human can read.
    ///
    /// Written against the unredacted build first and watched to fail, because
    /// an absence assertion passes vacuously when the value never reached the
    /// path in the first place: seeing it fail is the only thing that proves it
    /// is guarding something (`lesson_grep_the_installed_dep_before_wiring_a_binding`).
    ///
    /// This matters more here than anywhere else in the app. `StubTransport`
    /// records every request, a failing assertion prints them, and a forge error
    /// can reach a toast or a bug report, so a derived `Debug` would put a live
    /// credential in all three.
    #[test]
    fn the_token_never_reaches_a_debug_string_or_an_error() {
        const TOKEN: &str = "gho_liveTokenThatMustNotLeak";
        let req = HttpRequest {
            method: "GET",
            url: "https://api.test/user".into(),
            headers: vec![
                ("Authorization".into(), format!("Bearer {TOKEN}")),
                ("Accept".into(), "application/vnd.github+json".into()),
            ],
            body: None,
        };

        let debugged = format!("{req:?}");
        assert!(!debugged.contains(TOKEN), "Debug leaked the token: {debugged}");
        // Redacted, not dropped: knowing the request *was* authenticated is
        // exactly what you need when triaging a 401.
        assert!(debugged.contains("Authorization"), "the header name is still useful");
        assert!(debugged.contains("Accept"), "unrelated headers survive intact");
        assert!(
            debugged.contains("api.test/user"),
            "the URL survives, since it carries no secret"
        );

        // The seam records requests, so its own Debug output is a leak path too.
        let t = StubTransport::new(vec![StubTransport::json(401, r#"{"message":"Bad credentials"}"#)]);
        let err = t.send(req).map(|r| classify(&r)).unwrap();
        let seen = format!("{:?}", t.seen.lock().unwrap());
        assert!(!seen.contains(TOKEN), "the recorded request leaked the token: {seen}");
        assert!(!format!("{err:?}").contains(TOKEN), "the error leaked the token");
    }

    /// The device flow's token exchange answers with the credential in the
    /// *response body*, so redacting only the request header would still hand it
    /// over to whoever prints a response. Phase 2 is what walks into this.
    #[test]
    fn a_token_bearing_response_body_is_redacted_too() {
        const TOKEN: &str = "gho_exchangedTokenThatMustNotLeak";

        let json = StubTransport::json(
            200,
            &format!(r#"{{"access_token":"{TOKEN}","token_type":"bearer","scope":"repo"}}"#),
        );
        let debugged = format!("{json:?}");
        assert!(!debugged.contains(TOKEN), "response body leaked the token: {debugged}");
        // The key survives, so "did the exchange succeed?" is still answerable.
        assert!(debugged.contains("access_token"));
        assert!(debugged.contains("repo"), "non-secret fields stay readable");

        // The same endpoint answers form-encoded without an explicit Accept.
        let form = StubTransport::json(200, &format!("access_token={TOKEN}&scope=repo"));
        let debugged = format!("{form:?}");
        assert!(!debugged.contains(TOKEN), "form body leaked the token: {debugged}");
        assert!(debugged.contains("scope=repo"));

        // And the polled device_code, which is a short-lived secret of its own.
        let req = HttpRequest {
            method: "POST",
            url: "https://github.com/login/oauth/access_token".into(),
            headers: vec![],
            body: Some(r#"{"device_code":"dc_secret","client_id":"Iv1.public"}"#.into()),
        };
        let debugged = format!("{req:?}");
        assert!(!debugged.contains("dc_secret"), "device_code leaked: {debugged}");
        // The client id is public by design (device flow has no client secret),
        // so redacting it would cost triage nothing and gain nothing.
        assert!(debugged.contains("Iv1.public"));
    }

    #[test]
    fn header_lookup_ignores_case() {
        let resp = StubTransport::with_headers(200, &[("retry-after", "5")], "[]");
        assert_eq!(resp.header("Retry-After"), Some("5"));
    }

    #[test]
    fn link_next_is_parsed_not_reconstructed() {
        let header = r#"<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last""#;
        assert_eq!(parse_link_next(header), Some("https://api.github.com/x?page=2".into()));

        // The last page offers prev and first but no next.
        let last = r#"<https://api.github.com/x?page=8>; rel="prev", <https://api.github.com/x?page=1>; rel="first""#;
        assert_eq!(parse_link_next(last), None);
    }

    fn get(url: &str) -> HttpRequest {
        HttpRequest { method: "GET", url: url.into(), headers: vec![], body: None }
    }

    #[test]
    fn rest_pagination_follows_link_to_exhaustion() {
        let next = |p: u32| format!("<https://api.test/x?page={p}>; rel=\"next\"");
        let t = StubTransport::new(vec![
            StubTransport::with_headers(200, &[("Link", &next(2))], "[1,2]"),
            StubTransport::with_headers(200, &[("Link", &next(3))], "[3,4]"),
            StubTransport::json(200, "[5]"),
        ]);
        let (items, truncated) = paginate_rest(&t, get("https://api.test/x"), PAGE_CAP).unwrap();
        assert_eq!(items.len(), 5, "all three pages, not just the first");
        assert!(!truncated);
        assert_eq!(t.request_count(), 3);

        // The walker followed the header's URL rather than building its own.
        assert_eq!(t.seen.lock().unwrap()[1].url, "https://api.test/x?page=2");
    }

    #[test]
    fn rest_pagination_reports_truncation_instead_of_stopping_silently() {
        // Every page claims another, so the cap is what ends it. The caller must
        // be told, because a short list that renders as a complete one is the
        // failure nobody notices.
        let link = "<https://api.test/x?page=2>; rel=\"next\"";
        let t = StubTransport::new(vec![
            StubTransport::with_headers(200, &[("Link", link)], "[1]"),
            StubTransport::with_headers(200, &[("Link", link)], "[2]"),
        ]);
        let (items, truncated) = paginate_rest(&t, get("https://api.test/x"), 2).unwrap();
        assert_eq!(items.len(), 2);
        assert!(truncated, "hitting the cap must be reported, not silent");
    }

    #[test]
    fn rest_pagination_unwraps_a_wrapped_array() {
        // The Checks API returns `{ total_count, check_runs: [...] }`.
        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"total_count":2,"check_runs":[{"id":1},{"id":2}]}"#,
        )]);
        let (items, _) = paginate_rest(&t, get("https://api.test/x"), PAGE_CAP).unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn rest_pagination_surfaces_an_error_page_instead_of_returning_a_short_list() {
        let t = StubTransport::new(vec![StubTransport::json(401, r#"{"message":"Bad credentials"}"#)]);
        assert_eq!(
            paginate_rest(&t, get("https://api.test/x"), PAGE_CAP),
            Err(ForgeError::CredentialSuspect)
        );
    }

    // --- GraphQL ---

    fn outer_spec() -> ConnectionSpec {
        ConnectionSpec {
            path: vec!["repository".into(), "pullRequest".into(), "reviewThreads".into()],
            cursor_var: "after".into(),
        }
    }

    fn nested_spec() -> NestedSpec {
        NestedSpec {
            key: "comments".into(),
            query: "query($id:ID!,$commentsAfter:String){ node(id:$id){ ... } }".into(),
            id_var: "id".into(),
            cursor_var: "commentsAfter".into(),
            path: vec!["node".into(), "comments".into()],
        }
    }

    fn threads_page(nodes: &str, has_next: bool, cursor: &str) -> String {
        format!(
            r#"{{"data":{{"repository":{{"pullRequest":{{"reviewThreads":{{"nodes":[{nodes}],
               "pageInfo":{{"hasNextPage":{has_next},"endCursor":"{cursor}"}}}}}}}}}}}}"#
        )
    }

    fn thread(id: &str, comments: &str, has_next: bool, cursor: &str) -> String {
        format!(
            r#"{{"id":"{id}","comments":{{"nodes":[{comments}],
               "pageInfo":{{"hasNextPage":{has_next},"endCursor":"{cursor}"}}}}}}"#
        )
    }

    #[test]
    fn graphql_pagination_walks_outer_pages_and_nested_connections() {
        // Three pages of threads. The first thread on page one has a second
        // page of comments, which is the case a cursor walker that only paged
        // the outer connection would silently truncate.
        let t = StubTransport::new(vec![
            StubTransport::json(
                200,
                &threads_page(
                    &format!(
                        "{},{}",
                        thread("T1", r#"{"id":"C1"}"#, true, "cc1"),
                        thread("T2", r#"{"id":"C3"}"#, false, "cc0")
                    ),
                    true,
                    "tc1",
                ),
            ),
            StubTransport::json(
                200,
                &threads_page(&thread("T3", r#"{"id":"C4"}"#, false, ""), true, "tc2"),
            ),
            StubTransport::json(
                200,
                &threads_page(&thread("T4", r#"{"id":"C5"}"#, false, ""), false, "tc3"),
            ),
            // The follow-up query for T1's second page of comments.
            StubTransport::json(
                200,
                r#"{"data":{"node":{"comments":{"nodes":[{"id":"C2"}],
                   "pageInfo":{"hasNextPage":false,"endCursor":"cc2"}}}}}"#,
            ),
        ]);

        let nested = nested_spec();
        let (nodes, truncated) = paginate_graphql(
            &GraphqlEndpoint { transport: &t, url: "https://api.test/graphql", headers: &[] },
            "query($after:String){ ... }",
            &serde_json::json!({}),
            &outer_spec(),
            Some(&nested),
            PAGE_CAP,
        )
        .unwrap();

        assert_eq!(nodes.len(), 4, "every thread across all three pages");
        assert!(!truncated);

        // T1 carries both pages of its comments, stitched in place.
        let t1 = &nodes[0]["comments"]["nodes"];
        assert_eq!(t1.as_array().unwrap().len(), 2);
        assert_eq!(t1[0]["id"], "C1");
        assert_eq!(t1[1]["id"], "C2");

        // A thread that was already complete is left alone, no extra request.
        assert_eq!(nodes[1]["comments"]["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(t.request_count(), 4, "3 outer pages + 1 nested follow-up");
    }

    #[test]
    fn graphql_pagination_advances_the_outer_cursor_from_the_response() {
        let t = StubTransport::new(vec![
            StubTransport::json(200, &threads_page(&thread("T1", "", false, ""), true, "tc1")),
            StubTransport::json(200, &threads_page(&thread("T2", "", false, ""), false, "tc2")),
        ]);
        paginate_graphql(
            &GraphqlEndpoint { transport: &t, url: "https://api.test/graphql", headers: &[] },
            "q",
            &serde_json::json!({}),
            &outer_spec(),
            None,
            PAGE_CAP,
        )
        .unwrap();

        let seen = t.seen.lock().unwrap();
        let first: Value = serde_json::from_str(seen[0].body.as_ref().unwrap()).unwrap();
        let second: Value = serde_json::from_str(seen[1].body.as_ref().unwrap()).unwrap();
        assert_eq!(first["variables"]["after"], Value::Null, "page one has no cursor");
        assert_eq!(second["variables"]["after"], "tc1", "page two uses the server's cursor");
    }

    #[test]
    fn a_graphql_errors_array_is_an_error_not_an_empty_page() {
        // GraphQL answers 200 with `errors`, so a status-only check would read
        // this as a page with no nodes and page on happily.
        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}"#,
        )]);
        let err = paginate_graphql(
            &GraphqlEndpoint { transport: &t, url: "https://api.test/graphql", headers: &[] },
            "q",
            &serde_json::json!({}),
            &outer_spec(),
            None,
            PAGE_CAP,
        )
        .unwrap_err();
        assert!(matches!(err, ForgeError::Forbidden { .. }), "got {err:?}");
    }

    #[test]
    fn graphql_pagination_reports_truncation_at_the_cap() {
        let t = StubTransport::new(vec![
            StubTransport::json(200, &threads_page(&thread("T1", "", false, ""), true, "c1")),
            StubTransport::json(200, &threads_page(&thread("T2", "", false, ""), true, "c2")),
        ]);
        let (nodes, truncated) = paginate_graphql(
            &GraphqlEndpoint { transport: &t, url: "https://api.test/graphql", headers: &[] },
            "q",
            &serde_json::json!({}),
            &outer_spec(),
            None,
            2,
        )
        .unwrap();
        assert_eq!(nodes.len(), 2);
        assert!(truncated);
    }

    #[test]
    fn has_next_without_a_cursor_stops_instead_of_looping_on_page_one() {
        // A malformed page that claims more but offers no cursor would
        // otherwise re-request page one until the cap, wasting the budget.
        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"T1"}],
               "pageInfo":{"hasNextPage":true}}}}}}"#,
        )]);
        let (nodes, truncated) = paginate_graphql(
            &GraphqlEndpoint { transport: &t, url: "https://api.test/graphql", headers: &[] },
            "q",
            &serde_json::json!({}),
            &outer_spec(),
            None,
            PAGE_CAP,
        )
        .unwrap();
        assert_eq!(nodes.len(), 1);
        assert!(truncated);
        assert_eq!(t.request_count(), 1, "no re-request of page one");
    }
}
