use std::path::Path;
use std::sync::OnceLock;

use ort::environment::Environment;
use ort::session::builder::AutoDevicePolicy;
use ort::session::Session;

// ONNX Runtime allows one environment per process, and a model is loaded
// again after every idle drop or size switch.
static ENV: OnceLock<Environment> = OnceLock::new();

fn environment() -> Result<&'static Environment, String> {
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init()
        .with_execution_providers([ort::ep::CPU::default().build()])
        .build()
        .map_err(|e| format!("runtime: {e}"))?;
    Ok(ENV.get_or_init(|| env))
}

pub fn session(model: &Path) -> Result<Session, String> {
    let fail = |what: &str, e: &dyn std::fmt::Display| format!("{what}: {e}");
    let env = environment()?;
    // ort's default policy registers CoreML on a Mac, which compiles the
    // graph on every load (5 s here) and then runs it slower than the CPU.
    Session::builder(env)
        .map_err(|e| fail("runtime", &e))?
        .with_auto_device(AutoDevicePolicy::PreferCPU)
        .map_err(|e| fail("runtime", &e))?
        .commit_from_file(model)
        .map_err(|e| fail("model", &e))
}
