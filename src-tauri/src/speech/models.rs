// The names the downloads and the settings need on every Mac. The engines that
// read these files only build on Apple Silicon.

pub const AVAILABLE: bool = cfg!(target_arch = "aarch64");
pub const UNAVAILABLE: &str = "Read aloud and dictation need an Apple Silicon Mac";

pub const SAMPLE_RATE: u32 = 24_000;

pub mod kitten {
    pub const MODEL: &str = "kitten_tts_nano_v0_8.onnx";
    pub const VOICES_FILE: &str = "voices.npz";
    pub const DEFAULT_VOICE: &str = "expr-voice-2-f";

    pub const VOICES: &[(&str, &str, f32)] = &[
        ("expr-voice-2-f", "Bella", 0.8),
        ("expr-voice-2-m", "Jasper", 0.8),
        ("expr-voice-3-f", "Luna", 0.8),
        ("expr-voice-3-m", "Bruno", 0.8),
        ("expr-voice-4-f", "Rosie", 0.8),
        ("expr-voice-4-m", "Hugo", 0.9),
        ("expr-voice-5-f", "Kiki", 0.8),
        ("expr-voice-5-m", "Leo", 0.8),
    ];
}

pub mod moonshine {
    pub const ENCODER: &str = "encoder_model_quantized.onnx";
    pub const DECODER: &str = "decoder_model_merged_quantized.onnx";
    pub const TOKENIZER: &str = "tokenizer.json";
}

pub mod parakeet {
    pub const ENCODER: &str = "encoder-model.int8.onnx";
    pub const DECODER: &str = "decoder_joint-model.int8.onnx";
    pub const FEATURES: &str = "nemo128.onnx";
    pub const VOCAB: &str = "vocab.txt";
}
