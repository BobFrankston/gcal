// build-exe — compile the gcalics.exe .ics launcher and refresh the committed
// copy at bin/gcalics.exe, but ONLY when the binary actually changed.
//
// Wired into `npm run build` so npmglobalize regenerates the exe on publish.
// `cargo build --release` is itself incremental (a no-op when gcalics-src is
// unchanged), so running it every build is cheap. The byte-compare below means
// bin/gcalics.exe — and therefore its git diff — is only rewritten when the
// produced binary differs, keeping no-op builds clean.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'gcalics-src');
const built = path.join(srcDir, 'target', 'release', 'gcalics.exe');
const dest = path.join(here, 'gcalics.exe');

// The launcher is a Windows file-association handler; only build it on Windows.
// Elsewhere we keep the committed exe so a non-Windows publish still ships it.
if (process.platform !== 'win32') {
    console.log('build-exe: not Windows — keeping committed gcalics.exe.');
    process.exit(0);
}

try {
    execSync('cargo build --release', { cwd: srcDir, stdio: 'inherit' });
} catch {
    if (fs.existsSync(dest)) {
        console.warn('build-exe: cargo unavailable — shipping existing gcalics.exe.');
        process.exit(0);
    }
    console.error('build-exe: cargo build failed and no prebuilt gcalics.exe exists.');
    process.exit(1);
}

const fresh = fs.readFileSync(built);
const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
if (current && current.equals(fresh)) {
    console.log('build-exe: gcalics.exe unchanged.');
} else {
    fs.copyFileSync(built, dest);
    console.log('build-exe: gcalics.exe refreshed.');
}
