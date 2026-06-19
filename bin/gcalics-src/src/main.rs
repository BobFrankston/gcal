// gcalics — Win32 launcher for the OS-level .ics file association.
//
// Exists for ONE reason: Windows's "Open with" picker and the Win11 default-
// apps UI read an EXE's PE FileDescription as the display name. If we register
// `node.exe ... gcal.js "%1"` the picker shows "Node.js JavaScript Runtime"
// (shared by every node tool, and ambiguous). With this binary registered
// instead, the picker shows "gcal" (set in build.rs's VERSIONINFO), and gcal
// gets its own selectable entry via Applications\gcalics.exe.
//
// The runtime job is trivial: receive argv (the .ics path), find node + the
// installed gcal.js, run `node gcal.js <ics-path>`, show the import result,
// pause so the user can read it, exit.
//
// Unlike a mailto handler (which opens a GUI and wants to be windowless), an
// .ics import is a CLI that prints "Imported N events" — so this is a CONSOLE
// subsystem app: double-clicking shows the result. We wait for node and then
// pause for a keypress unless GCAL_ICS_NOPAUSE is set. The VERSIONINFO
// FileDescription still drives the picker name regardless of subsystem.
//
// Lookup order for node + gcal.js:
//   1. NODE_EXE / GCAL_JS env vars (test override / unusual installs).
//   2. %APPDATA%\npm\node_modules\@bobfrankston\gcal\gcal.js
//      (standard `npm install -g @bobfrankston/gcal` location).
//   3. PATH lookup for `node.exe`; gcal.js walked up from the exe (dev mode).

use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;

fn find_node() -> Option<PathBuf> {
    if let Ok(p) = env::var("NODE_EXE") {
        let pb = PathBuf::from(p);
        if pb.is_file() { return Some(pb); }
    }
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        for name in &["node.exe", "node"] {
            let candidate = dir.join(name);
            if candidate.is_file() { return Some(candidate); }
        }
    }
    None
}

fn find_gcal_js() -> Option<PathBuf> {
    if let Ok(p) = env::var("GCAL_JS") {
        let pb = PathBuf::from(p);
        if pb.is_file() { return Some(pb); }
    }
    // Standard global-install location.
    if let Ok(appdata) = env::var("APPDATA") {
        let pb = PathBuf::from(appdata)
            .join("npm").join("node_modules")
            .join("@bobfrankston").join("gcal")
            .join("gcal.js");
        if pb.is_file() { return Some(pb); }
    }
    // Fallback: relative to this binary, walking up to find `gcal.js`. Lets a
    // dev-mode build (gcalics.exe in bin/ next to a repo that has gcal.js one
    // level up) work without env-var fiddling.
    if let Ok(exe) = env::current_exe() {
        let mut p = exe.clone();
        for _ in 0..5 {
            if let Some(parent) = p.parent() {
                let candidate = parent.join("gcal.js");
                if candidate.is_file() { return Some(candidate); }
                p = parent.to_path_buf();
            } else {
                break;
            }
        }
    }
    None
}

fn pause() {
    if env::var_os("GCAL_ICS_NOPAUSE").is_some() { return; }
    print!("\nPress Enter to close...");
    let _ = std::io::stdout().flush();
    let mut buf = [0u8; 1];
    let _ = std::io::stdin().read(&mut buf);
}

fn fail(msg: &str, code: i32) -> ! {
    eprintln!("gcal .ics import: {msg}");
    pause();
    std::process::exit(code);
}

fn main() {
    // argv[0] is the exe path itself; argv[1] should be the .ics file path.
    let ics_path = match env::args().nth(1) {
        Some(u) if !u.is_empty() => u,
        _ => fail("invoked without an .ics file path.\n\nUsage: gcalics.exe <file.ics>", 1),
    };

    let node = match find_node() {
        Some(p) => p,
        None => fail("Node.js was not found on PATH.\n\ngcal requires Node.js. See https://nodejs.org", 2),
    };
    let gcal_js = match find_gcal_js() {
        Some(p) => p,
        None => fail(
            "gcal.js was not located.\n\nExpected at:\n  %APPDATA%\\npm\\node_modules\\@bobfrankston\\gcal\\gcal.js\n\nSet GCAL_JS to override.",
            3,
        ),
    };

    // Run node attached so its import output shows in this console window.
    let status = Command::new(&node)
        .arg(&gcal_js)
        .arg(&ics_path)
        .status();
    match status {
        Ok(s) => {
            pause();
            std::process::exit(s.code().unwrap_or(0));
        }
        Err(e) => fail(
            &format!("failed to launch gcal.\n  node:   {}\n  script: {}\n  error:  {e}", node.display(), gcal_js.display()),
            4,
        ),
    }
}
