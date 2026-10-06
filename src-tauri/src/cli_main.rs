// The console twin of the app binary, shipped beside it on Windows. A GUI
// subsystem exe gets no console, so `tori sessions` from a shell would print
// nothing and the prompt would not wait for it.

fn main() {
    std::process::exit(tori_lib::helper_mode().unwrap_or_else(tori_lib::cli_usage))
}
