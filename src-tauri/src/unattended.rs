//! What changes for a session nobody is watching: whether it starts in the
//! agent's own sandbox, and the shell commands it may not run.

use serde_json::{json, Value};

use crate::settings::ExecutionLevel;

/// Decided once, at spawn or resume. A running session is not re-boxed when
/// somebody walks away; the deny list covers that.
pub fn boxed(level: ExecutionLevel, background: bool, attached: bool) -> bool {
    match level {
        ExecutionLevel::AsMe => false,
        ExecutionLevel::BoxedWhenUnattended => background || !attached,
        ExecutionLevel::AlwaysBoxed => true,
    }
}

pub fn level_for(cwd: &str) -> ExecutionLevel {
    let project = crate::rpc::events::project_of(cwd, &crate::config::discovered_project_dirs());
    crate::settings::execution_level(project.as_deref().unwrap_or(cwd))
}

pub fn claude_sandbox(cwd: &str) -> Value {
    let mut domains = crate::settings::unattended().allowed_domains();
    domains.extend(forge_host(cwd));
    sandbox_json(&domains, &crate::rpc::daemon::paths().sock.to_string_lossy())
}

// `allowUnsandboxedCommands: false` is what stops the agent retrying a failed
// command outside the box, and it arrives through `--settings`, which a repo's
// own `.claude/settings.json` cannot loosen.
fn sandbox_json(domains: &[String], tori_sock: &str) -> Value {
    json!({
        "enabled": true,
        "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "network": {
            "allowedDomains": domains,
            "allowUnixSockets": [tori_sock],
        },
    })
}

fn forge_host(cwd: &str) -> Option<String> {
    let url = crate::git::remote_url(cwd, "origin").ok()??;
    crate::forge::remote::parse(&url).ok().map(|remote| remote.host)
}

pub fn shell_refusal(tool: &str, input: &Value) -> Option<String> {
    if tool != "Bash" {
        return None;
    }
    let command = input["command"].as_str().unwrap_or_default();
    refusal_for(command, &crate::settings::unattended().deny(), crate::rpc::attached())
}

fn refusal_for(command: &str, deny: &[String], attached: bool) -> Option<String> {
    if attached {
        return None;
    }
    deny_match(command, deny).map(|entry| {
        format!(
            "Tori blocked this: `{entry}` may not run while nobody is at the window or the phone. \
             Leave it for the user and tell them what it was for."
        )
    })
}

pub fn unreachable_refusal(entry: &str) -> String {
    format!(
        "Tori blocked this: `{entry}` may not run while nobody is watching, and Tori could not be reached to check \
         whether anybody is."
    )
}

/// The deny entry `command` would run, if any. A tripwire for the usual
/// spellings, not a boundary: a script or a Makefile that runs one gets past.
pub fn deny_match<'a>(command: &str, deny: &'a [String]) -> Option<&'a str> {
    segments(command, 0)
        .iter()
        .find_map(|words| deny.iter().find(|entry| matches(words, entry)))
        .map(String::as_str)
}

fn matches(words: &[String], entry: &str) -> bool {
    let mut want = entry.split_whitespace();
    let Some(head) = want.next() else {
        return false;
    };
    if words.first().map(String::as_str) != Some(basename(head)) {
        return false;
    }
    let mut rest = words[1..].iter();
    want.all(|w| rest.any(|word| word == w))
}

const MAX_DEPTH: usize = 4;

fn segments(command: &str, depth: usize) -> Vec<Vec<String>> {
    let lexed = lex(command);
    let mut out = Vec::new();
    for words in lexed.segments {
        let words = command_words(&words);
        if depth < MAX_DEPTH {
            if let Some(body) = shell_body(&words) {
                out.extend(segments(&body, depth + 1));
            }
        }
        out.push(words);
    }
    if depth < MAX_DEPTH {
        for text in lexed.quoted_substitutions {
            out.extend(segments(&text, depth + 1));
        }
    }
    out
}

const KEYWORDS: [&str; 10] = ["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"];

const WRAPPERS: [(&str, &[&str]); 7] = [
    ("sudo", &["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D", "-T"]),
    ("env", &["-u", "-C"]),
    ("nice", &["-n"]),
    ("exec", &["-a"]),
    ("command", &[]),
    ("nohup", &[]),
    ("time", &[]),
];

fn command_words(words: &[String]) -> Vec<String> {
    let mut rest = words;
    while let Some(first) = rest.first() {
        if KEYWORDS.contains(&first.as_str()) || is_assignment(first) {
            rest = &rest[1..];
        } else if let Some((_, takes_arg)) = WRAPPERS.iter().find(|(name, _)| *name == basename(first)) {
            rest = skip_options(&rest[1..], takes_arg);
        } else {
            break;
        }
    }
    let mut out = rest.to_vec();
    if let Some(first) = out.first_mut() {
        *first = basename(first).to_string();
    }
    out
}

fn skip_options<'a>(mut words: &'a [String], takes_arg: &[&str]) -> &'a [String] {
    while let Some(first) = words.first() {
        if first == "--" {
            return &words[1..];
        }
        if !first.starts_with('-') {
            break;
        }
        let skip = if takes_arg.contains(&first.as_str()) { 2 } else { 1 };
        words = &words[skip.min(words.len())..];
    }
    words
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn basename(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn shell_body(words: &[String]) -> Option<String> {
    let (first, rest) = words.split_first()?;
    match first.as_str() {
        "eval" => Some(rest.join(" ")),
        "sh" | "bash" | "zsh" | "dash" => {
            let mut rest = rest.iter();
            while let Some(word) = rest.next() {
                if word.starts_with("--") {
                    continue;
                }
                if !word.starts_with('-') {
                    return None;
                }
                if word.contains('c') {
                    return rest.find(|w| !w.starts_with('-')).cloned();
                }
            }
            None
        }
        _ => None,
    }
}

#[derive(Default)]
struct Lexed {
    segments: Vec<Vec<String>>,
    quoted_substitutions: Vec<String>,
    current: Vec<String>,
    word: String,
    in_word: bool,
    substitution_at: Option<usize>,
}

impl Lexed {
    fn push(&mut self, c: char) {
        self.word.push(c);
        self.in_word = true;
    }

    fn end_word(&mut self) {
        if !self.in_word {
            return;
        }
        if let Some(at) = self.substitution_at.take() {
            self.quoted_substitutions.push(self.word[at..].to_string());
        }
        self.current.push(std::mem::take(&mut self.word));
        self.in_word = false;
    }

    fn end_segment(&mut self) {
        self.end_word();
        if !self.current.is_empty() {
            self.segments.push(std::mem::take(&mut self.current));
        }
    }
}

fn lex(command: &str) -> Lexed {
    let mut lx = Lexed::default();
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next().filter(|&n| n != '\n') {
                    lx.push(next);
                }
            }
            '\'' => {
                lx.in_word = true;
                for next in chars.by_ref() {
                    if next == '\'' {
                        break;
                    }
                    lx.word.push(next);
                }
            }
            '"' => {
                lx.in_word = true;
                while let Some(next) = chars.next() {
                    match next {
                        '"' => break,
                        '\\' => {
                            if let Some(escaped) = chars.next() {
                                lx.word.push(escaped);
                            }
                        }
                        '`' => {
                            lx.substitution_at.get_or_insert(lx.word.len());
                            lx.word.push(next);
                        }
                        '$' if chars.peek() == Some(&'(') => {
                            lx.substitution_at.get_or_insert(lx.word.len());
                            lx.word.push(next);
                        }
                        _ => lx.word.push(next),
                    }
                }
            }
            '#' if !lx.in_word => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
                lx.end_segment();
            }
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                lx.end_segment();
            }
            '&' if lx.word.ends_with(['>', '<']) => lx.push(c),
            '&' | '|' => {
                if chars.peek() == Some(&c) || chars.peek() == Some(&'&') {
                    chars.next();
                }
                lx.end_segment();
            }
            ';' | '\n' | '(' | ')' | '`' => lx.end_segment(),
            ' ' | '\t' => lx.end_word(),
            _ => lx.push(c),
        }
    }
    lx.end_segment();
    lx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deny() -> Vec<String> {
        crate::settings::default_deny()
    }

    #[test]
    fn the_box_follows_the_level_background_and_attachment() {
        use ExecutionLevel::*;
        for (level, background, attached, want) in [
            (AsMe, false, false, false),
            (AsMe, true, false, false),
            (AsMe, true, true, false),
            (BoxedWhenUnattended, false, true, false),
            (BoxedWhenUnattended, false, false, true),
            (BoxedWhenUnattended, true, true, true),
            (BoxedWhenUnattended, true, false, true),
            (AlwaysBoxed, false, true, true),
            (AlwaysBoxed, false, false, true),
            (AlwaysBoxed, true, true, true),
        ] {
            assert_eq!(
                boxed(level, background, attached),
                want,
                "{level:?} background={background} attached={attached}"
            );
        }
    }

    #[test]
    fn a_resume_with_no_window_boxes_a_boxed_when_unattended_chat() {
        assert!(!crate::rpc::attached(), "outside the daemon nobody is attached");
        assert!(boxed(
            ExecutionLevel::BoxedWhenUnattended,
            false,
            crate::rpc::attached()
        ));
    }

    #[test]
    fn the_usual_spellings_of_a_denied_command_are_caught() {
        for (command, entry) in [
            ("aws sts get-caller-identity", "aws"),
            ("FOO=1 aws s3 rm s3://b/k", "aws"),
            ("cd x && terraform destroy", "terraform"),
            ("bash -c \"kubectl delete ns x\"", "kubectl"),
            ("/usr/local/bin/aws s3 ls", "aws"),
            ("git push -f", "git push -f"),
            ("git push origin main --force", "git push --force"),
            ("sudo -u deploy env AWS_PROFILE=x aws s3 ls", "aws"),
            ("ls | xargs echo; (psql -c 'drop table t')", "psql"),
            ("echo \"$(gcloud auth print-access-token)\"", "gcloud"),
            ("echo `fly deploy`", "fly"),
            ("sh -lc 'zsh -c \"eval redis-cli flushall\"'", "redis-cli"),
            ("make build || pulumi up", "pulumi"),
            ("if true; then mysql -e 'select 1'; fi", "mysql"),
        ] {
            assert_eq!(deny_match(command, &deny()), Some(entry), "{command}");
        }
    }

    #[test]
    fn plain_commands_and_quoted_text_pass() {
        for command in [
            "git push",
            "git push origin main",
            "git push --force-with-lease",
            "echo aws",
            "grep -r 'kubectl delete' .",
            "git commit -m \"git push -f later\"",
            "echo '$(aws s3 ls)'",
            "cargo test 2>&1 | tail",
            "ls ~/.aws",
        ] {
            assert_eq!(deny_match(command, &deny()), None, "{command}");
        }
    }

    #[test]
    fn a_match_is_refused_only_while_nobody_is_attached() {
        let reason = refusal_for("aws s3 ls", &deny(), false).expect("unattended");
        assert!(reason.contains("`aws`"), "{reason}");
        assert_eq!(refusal_for("aws s3 ls", &deny(), true), None);
        assert_eq!(refusal_for("ls", &deny(), false), None);
    }

    #[test]
    fn the_sandbox_cannot_be_left_and_lets_the_tori_cli_through() {
        let domains = vec!["pypi.org".to_string(), "github.com".to_string()];
        let sandbox = sandbox_json(&domains, "/tmp/tori/sock");
        assert_eq!(sandbox["enabled"], true);
        assert_eq!(sandbox["failIfUnavailable"], true);
        assert_eq!(sandbox["allowUnsandboxedCommands"], false);
        assert_eq!(sandbox["network"]["allowedDomains"], json!(["pypi.org", "github.com"]));
        assert_eq!(sandbox["network"]["allowUnixSockets"], json!(["/tmp/tori/sock"]));
    }
}
