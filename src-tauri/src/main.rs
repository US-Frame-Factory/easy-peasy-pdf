// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--render-worker") {
        std::process::exit(quick_fast_pdf_lib::worker::run(&args));
    }
    if args.iter().any(|a| a == "--save-markups") {
        std::process::exit(quick_fast_pdf_lib::annotate::run(&args));
    }
    if let Some(i) = args.iter().position(|a| a == "--bench") {
        // Headless benchmark: --bench <file.pdf> [scale]
        std::process::exit(quick_fast_pdf_lib::bench::run(&args[i + 1..]));
    }
    quick_fast_pdf_lib::run();
}
