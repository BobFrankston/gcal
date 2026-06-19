// Embed Win32 VERSIONINFO so the "Open with" picker and Win11 default-apps UI
// show this launcher as "gcal" instead of falling through to the host EXE's
// PE FileDescription ("Node.js JavaScript Runtime"). These keys populate the
// picker's display name.

#[cfg(windows)]
fn main() {
    let mut res = winres::WindowsResource::new();
    res.set("ProductName", "gcal");
    res.set("FileDescription", "gcal");
    res.set("CompanyName", "Bob Frankston");
    res.set("LegalCopyright", "MIT");
    res.set("OriginalFilename", "gcalics.exe");
    res.set("InternalName", "gcalics");
    // Embed an icon for the picker tile if one is shipped next to the crate.
    let ico = std::path::Path::new("../icon.ico");
    if ico.exists() {
        res.set_icon(ico.to_str().unwrap());
    }
    if let Err(e) = res.compile() {
        eprintln!("winres compile failed: {e}");
    }
}

#[cfg(not(windows))]
fn main() {}
