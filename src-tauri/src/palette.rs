// Theme palette schema, Rust side.
//
// Mirrors src/theme/schema.ts. A palette is PRIMITIVES only: flat hex strings,
// no expressions and no references between keys, so a user-authored file in
// ~/.config/sway/themes/ can never become an evaluator. All derivation (alpha
// washes, shadow stacks, the semantic role names) happens in the frontend's
// roles.ts.
//
// Loading user palettes off disk and watching that directory arrives with the
// themes loader; this module is the shared contract both sides validate
// against. See adr_theme_palette_roles.

use serde::{Deserialize, Serialize};

pub const PALETTE_SCHEMA_VERSION: u32 = 1;

/// Whether the OS should draw native scrollbars/controls light or dark.
/// Metadata only: it selects no colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Appearance {
    Dark,
    Light,
}

/// The primitive set. Field order matches `PALETTE_KEYS` in schema.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaletteColors {
    // Surfaces
    pub canvas: String,
    pub card: String,
    pub head: String,
    pub input: String,
    pub hover: String,

    // Lines
    pub border_tint: String,
    pub line_tint: String,
    pub rail: String,

    // Text
    pub text: String,
    pub text_muted: String,
    pub text_subtle: String,
    pub text_on_emphasis: String,

    // Accent
    pub accent: String,
    pub accent_subtle: String,

    // Feedback
    pub danger: String,
    pub danger_strong: String,
    pub attention: String,
    pub attention_strong: String,
    pub success: String,
    pub success_strong: String,
    pub info: String,
    pub fill_tint: String,

    // VCS / diff
    pub diff_added: String,
    pub diff_modified: String,
    pub diff_deleted: String,

    // Diagnostics
    pub diag_error: String,
    pub diag_warning: String,
    pub diag_info: String,
    pub diag_hint: String,

    // Agent marks
    pub agent_claude: String,
    pub agent_pi: String,

    // Overlays
    pub scrim_tint: String,
    pub shadow_tint: String,
    pub glow_tint: String,

    // Session status indicators
    pub status_progress: String,
    pub status_needs_you: String,
    pub status_idle: String,
    pub status_running: String,

    // Brand
    pub brand: String,
    pub brand_strong: String,
    pub brand_tint: String,
    pub brand_on: String,

    // Terminal ANSI
    pub ansi_cursor: String,
    pub ansi_selection_tint: String,
    pub ansi_black: String,
    pub ansi_red: String,
    pub ansi_green: String,
    pub ansi_yellow: String,
    pub ansi_blue: String,
    pub ansi_magenta: String,
    pub ansi_cyan: String,
    pub ansi_white: String,
    pub ansi_bright_black: String,
    pub ansi_bright_red: String,
    pub ansi_bright_green: String,
    pub ansi_bright_yellow: String,
    pub ansi_bright_blue: String,
    pub ansi_bright_magenta: String,
    pub ansi_bright_cyan: String,
    pub ansi_bright_white: String,

    // Icon scale
    pub scale_red: String,
    pub scale_green: String,
    pub scale_blue: String,
    pub scale_yellow: String,
    pub scale_slate: String,
    pub scale_orange: String,
    pub scale_purple: String,
    pub scale_pink: String,
    pub scale_silver: String,
    pub scale_steel: String,
    pub scale_graphite: String,

    // Syntax
    pub syn_keyword: String,
    pub syn_control: String,
    pub syn_operator: String,
    pub syn_string: String,
    pub syn_escape: String,
    pub syn_regexp: String,
    pub syn_comment: String,
    pub syn_number: String,
    pub syn_constant: String,
    pub syn_function: String,
    pub syn_method: String,
    pub syn_type: String,
    pub syn_class: String,
    pub syn_namespace: String,
    pub syn_variable: String,
    pub syn_property: String,
    pub syn_parameter: String,
    pub syn_tag: String,
    pub syn_attribute: String,
    pub syn_punctuation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Palette {
    pub schema_version: u32,
    pub id: String,
    pub label: String,
    pub appearance: Appearance,
    pub colors: PaletteColors,
}

/// `#rgb`, `#rrggbb`, or `#rrggbbaa`.
fn is_hex(value: &str) -> bool {
    let Some(body) = value.strip_prefix('#') else {
        return false;
    };
    matches!(body.len(), 3 | 6 | 8) && body.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Palette {
    /// Structural validation beyond what serde enforces. Returns the problems
    /// found; empty means usable.
    ///
    /// Legibility is deliberately NOT checked here: a palette can be
    /// structurally perfect and still be white-on-white, which is the contrast
    /// gate's job.
    pub fn validate(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if self.schema_version != PALETTE_SCHEMA_VERSION {
            problems.push(format!(
                "schemaVersion must be {PALETTE_SCHEMA_VERSION}, got {}",
                self.schema_version
            ));
        }
        if self.id.trim().is_empty() {
            problems.push("id is required".to_string());
        }
        if self.label.trim().is_empty() {
            problems.push("label is required".to_string());
        }
        for (key, value) in self.colors.entries() {
            if !is_hex(value) {
                problems.push(format!("colors.{key} is not a hex colour: {value}"));
            }
        }
        problems
    }
}

impl PaletteColors {
    /// Every colour as (camelCase key, value), so validation and the contrast
    /// gate can iterate without a second hand-maintained list.
    pub fn entries(&self) -> Vec<(&'static str, &str)> {
        vec![
            ("canvas", &self.canvas),
            ("card", &self.card),
            ("head", &self.head),
            ("input", &self.input),
            ("hover", &self.hover),
            ("borderTint", &self.border_tint),
            ("lineTint", &self.line_tint),
            ("rail", &self.rail),
            ("text", &self.text),
            ("textMuted", &self.text_muted),
            ("textSubtle", &self.text_subtle),
            ("textOnEmphasis", &self.text_on_emphasis),
            ("accent", &self.accent),
            ("accentSubtle", &self.accent_subtle),
            ("danger", &self.danger),
            ("dangerStrong", &self.danger_strong),
            ("attention", &self.attention),
            ("attentionStrong", &self.attention_strong),
            ("success", &self.success),
            ("successStrong", &self.success_strong),
            ("info", &self.info),
            ("fillTint", &self.fill_tint),
            ("diffAdded", &self.diff_added),
            ("diffModified", &self.diff_modified),
            ("diffDeleted", &self.diff_deleted),
            ("diagError", &self.diag_error),
            ("diagWarning", &self.diag_warning),
            ("diagInfo", &self.diag_info),
            ("diagHint", &self.diag_hint),
            ("agentClaude", &self.agent_claude),
            ("agentPi", &self.agent_pi),
            ("scrimTint", &self.scrim_tint),
            ("shadowTint", &self.shadow_tint),
            ("glowTint", &self.glow_tint),
            ("statusProgress", &self.status_progress),
            ("statusNeedsYou", &self.status_needs_you),
            ("statusIdle", &self.status_idle),
            ("statusRunning", &self.status_running),
            ("brand", &self.brand),
            ("brandStrong", &self.brand_strong),
            ("brandTint", &self.brand_tint),
            ("brandOn", &self.brand_on),
            ("ansiCursor", &self.ansi_cursor),
            ("ansiSelectionTint", &self.ansi_selection_tint),
            ("ansiBlack", &self.ansi_black),
            ("ansiRed", &self.ansi_red),
            ("ansiGreen", &self.ansi_green),
            ("ansiYellow", &self.ansi_yellow),
            ("ansiBlue", &self.ansi_blue),
            ("ansiMagenta", &self.ansi_magenta),
            ("ansiCyan", &self.ansi_cyan),
            ("ansiWhite", &self.ansi_white),
            ("ansiBrightBlack", &self.ansi_bright_black),
            ("ansiBrightRed", &self.ansi_bright_red),
            ("ansiBrightGreen", &self.ansi_bright_green),
            ("ansiBrightYellow", &self.ansi_bright_yellow),
            ("ansiBrightBlue", &self.ansi_bright_blue),
            ("ansiBrightMagenta", &self.ansi_bright_magenta),
            ("ansiBrightCyan", &self.ansi_bright_cyan),
            ("ansiBrightWhite", &self.ansi_bright_white),
            ("scaleRed", &self.scale_red),
            ("scaleGreen", &self.scale_green),
            ("scaleBlue", &self.scale_blue),
            ("scaleYellow", &self.scale_yellow),
            ("scaleSlate", &self.scale_slate),
            ("scaleOrange", &self.scale_orange),
            ("scalePurple", &self.scale_purple),
            ("scalePink", &self.scale_pink),
            ("scaleSilver", &self.scale_silver),
            ("scaleSteel", &self.scale_steel),
            ("scaleGraphite", &self.scale_graphite),
            ("synKeyword", &self.syn_keyword),
            ("synControl", &self.syn_control),
            ("synOperator", &self.syn_operator),
            ("synString", &self.syn_string),
            ("synEscape", &self.syn_escape),
            ("synRegexp", &self.syn_regexp),
            ("synComment", &self.syn_comment),
            ("synNumber", &self.syn_number),
            ("synConstant", &self.syn_constant),
            ("synFunction", &self.syn_function),
            ("synMethod", &self.syn_method),
            ("synType", &self.syn_type),
            ("synClass", &self.syn_class),
            ("synNamespace", &self.syn_namespace),
            ("synVariable", &self.syn_variable),
            ("synProperty", &self.syn_property),
            ("synParameter", &self.syn_parameter),
            ("synTag", &self.syn_tag),
            ("synAttribute", &self.syn_attribute),
            ("synPunctuation", &self.syn_punctuation),
        ]
    }
}
