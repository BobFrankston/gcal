/**
 * AI-powered event extraction for gcal
 * Uses Anthropic Claude to parse natural language event descriptions
 * Shares API keys with gcards (%APPDATA%\gcards\keys.env)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createInterface } from 'readline/promises';
import clipboardy from 'clipboardy';

// Load keys from shared gcards location
function loadKeysEnv(): void {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || path.join(home, '.config');

    const locations = [
        path.join(appData, 'gcards', 'keys.env'),
        path.join(home, '.gcards', 'keys.env'),
        path.join(process.cwd(), 'keys.env'),
        path.join(process.cwd(), '.env'),
    ];

    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            const content = fs.readFileSync(loc, 'utf-8');
            for (const line of content.split(/\r?\n/)) {
                const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
                if (match && !process.env[match[1]]) {
                    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
                }
            }
            break;
        }
    }
}

loadKeysEnv();

function keysEnvPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || path.join(home, '.config');
    return path.join(appData, 'gcards', 'keys.env');
}

/**
 * Return ANTHROPIC_API_KEY, prompting the user (if interactive) and
 * persisting to keys.env when it isn't already set. Returns empty string
 * if the user declines or stdin is non-interactive.
 */
async function ensureAnthropicKey(): Promise<string> {
    const existing = process.env.ANTHROPIC_API_KEY;
    if (existing) return existing;

    const keysPath = keysEnvPath();
    if (!process.stdin.isTTY) {
        console.error(`\nANTHROPIC_API_KEY not set.`);
        console.error(`Add it to: ${keysPath}`);
        console.error(`Format: ANTHROPIC_API_KEY=sk-ant-...\n`);
        return '';
    }

    console.log(`\nANTHROPIC_API_KEY not set. Will save to ${keysPath}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const key = (await rl.question('Paste key (blank to abort): ')).trim();
    rl.close();
    if (!key) return '';
    if (!key.startsWith('sk-ant-')) {
        console.error('Does not look like an Anthropic key (expected sk-ant-...).');
        return '';
    }

    fs.mkdirSync(path.dirname(keysPath), { recursive: true });
    let content = fs.existsSync(keysPath) ? fs.readFileSync(keysPath, 'utf-8') : '';
    if (/^ANTHROPIC_API_KEY=/m.test(content)) {
        content = content.replace(/^ANTHROPIC_API_KEY=.*$/m, `ANTHROPIC_API_KEY=${key}`);
    } else {
        if (content && !content.endsWith('\n')) content += '\n';
        content += `ANTHROPIC_API_KEY=${key}\n`;
    }
    fs.writeFileSync(keysPath, content);
    process.env.ANTHROPIC_API_KEY = key;
    console.log(`Saved.`);
    return key;
}

export interface ExtractedEvent {
    summary: string;
    startDateTime: string;
    duration: string;
    timeZone?: string;
    location?: string;
    description?: string;
    free?: boolean;     /** true when the text says the time is not blocked (free/tentative/optional/FYI) */
}

// NOTE: rmfmail's New-event dialog uses this same prompt (mailx-service
// extractEventGcalStyle) — keep the two in sync when editing.
// 2026-09-16 — Claude Code (Fable 5.1), at Bob's direction: added the optional
// "free" field so the text can mark an event as not busy. rmfmail's copy NOT
// updated here (outside this tree); sync it there when convenient.
const EVENT_EXTRACTION_PROMPT = `Extract calendar event details from the user's text and return ONLY valid JSON.

Today's date is {{TODAY}} and the current local time is {{NOW}}. The user's local timezone is {{TIMEZONE}}.

The text may describe one or multiple events. Always return a JSON array of event objects.

Output format:
[
  {
    "summary": "Event title",
    "startDateTime": "YYYY-MM-DDTHH:mm:ss",
    "duration": "1h",
    "timeZone": "IANA timezone",
    "location": "optional location",
    "description": "optional description",
    "free": false
  }
]

Rules:
- summary: concise event title
- startDateTime: ISO format, resolve relative dates (tomorrow, next Friday, etc.) using today's date
- If only a time of day is given with no date and that time has already passed today (compare against the current local time), schedule it for tomorrow
- duration: format as "Xh", "Xm", or "XhYm" (default "1h" if not specified)
- timeZone: IANA timezone (e.g. "America/New_York"). If the text explicitly states a timezone — a zone name, abbreviation, UTC offset, or a parenthetical like "(Malaysia Time - Kuala Lumpur)" as in Google Calendar invitation emails — use that zone, and give startDateTime as the wall-clock time IN THAT ZONE (do not convert to the user's timezone). Otherwise infer from the event's location if it is clearly in a different timezone than the user. Default to the user's local timezone only when nothing indicates one.
- location: include if mentioned, omit if not
- description: include extra details if any, omit if none
- free: true ONLY if the text says the time should not be blocked — e.g. "free", "not busy", "show as free", "tentative", "optional", "FYI", "no need to attend", "hold" / "placeholder", "available". Otherwise omit it or set false (the event blocks the time as busy)
- Return ONLY the JSON array, no markdown, no explanation`;

/** Appended to the system prompt when the input is an image rather than text. */
const IMAGE_INPUT_ADDENDUM = `

The input is an image — typically a screenshot of an invitation, email, meeting
request, flyer, poster, or calendar page. Read all visible text, including dates,
times, timezones, and locations, and extract the event(s) it describes. Ignore
surrounding chrome (browser tabs, toolbars, signatures, ads). If the image shows
no identifiable event, return an empty JSON array.`;

type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export async function extractEventsFromText(text: string): Promise<ExtractedEvent[]> {
    return extractEvents([{ type: 'text', text }], false);
}

/** Extract events from a clipboard/file image (screenshot of an invite, flyer, etc.) */
export async function extractEventsFromImage(image: ClipboardImage): Promise<ExtractedEvent[]> {
    return extractEvents([
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: 'Extract the calendar event(s) shown in this image.' }
    ], true);
}

async function extractEvents(blocks: ContentBlock[], isImage: boolean): Promise<ExtractedEvent[]> {
    const apiKey = await ensureAnthropicKey();
    if (!apiKey) return [];

    // Local wall-clock, not toISOString() — UTC date is tomorrow during a
    // late-evening run, which shifted every relative date by a day.
    const nowD = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const today = `${nowD.getFullYear()}-${p2(nowD.getMonth() + 1)}-${p2(nowD.getDate())}`;
    const nowHM = `${p2(nowD.getHours())}:${p2(nowD.getMinutes())}`;
    const dayName = nowD.toLocaleDateString('en-US', { weekday: 'long' });
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const systemPrompt = EVENT_EXTRACTION_PROMPT
        .replace('{{TODAY}}', `${today} (${dayName})`)
        .replace('{{NOW}}', nowHM)
        .replace('{{TIMEZONE}}', localTz)
        + (isImage ? IMAGE_INPUT_ADDENDUM : '');

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 2048,
                system: systemPrompt,
                messages: [{
                    role: 'user',
                    content: blocks
                }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Claude API error: ${response.status} ${errorText}`);
            return [];
        }

        const data = await response.json() as any;
        const content = data.content?.[0]?.text;
        if (!content) return [];

        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            // Fall back to single object for backward compat
            const objMatch = content.match(/\{[\s\S]*\}/);
            if (!objMatch) {
                console.error('No JSON found in AI response');
                return [];
            }
            return [JSON.parse(objMatch[0]) as ExtractedEvent];
        }

        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
            return parsed as ExtractedEvent[];
        }
        return [parsed as ExtractedEvent];
    } catch (error) {
        console.error(`Error extracting event: ${error}`);
        return [];
    }
}

export interface ExtractedTask {
    title: string;
    due?: string;       /** YYYY-MM-DD, optional */
    notes?: string;
}

const TASK_EXTRACTION_PROMPT = `Extract to-do tasks from the user's text and return ONLY valid JSON.

Today's date is {{TODAY}}.

The text may describe one or multiple tasks. Always return a JSON array of task objects.

Output format:
[
  {
    "title": "Task title",
    "due": "YYYY-MM-DD",
    "notes": "optional details"
  }
]

Rules:
- title: concise task title (imperative if natural, e.g. "Call plumber")
- due: date-only (YYYY-MM-DD). Resolve relative dates ("tomorrow", "next Friday") using today's date. Omit if no date is implied.
- notes: include supporting details the title doesn't already capture. Omit if none.
- Google Tasks ignores time-of-day, so do not include hours/minutes.
- Return ONLY the JSON array, no markdown, no explanation`;

export async function extractTasksFromText(text: string): Promise<ExtractedTask[]> {
    const apiKey = await ensureAnthropicKey();
    if (!apiKey) return [];

    const today = new Date().toISOString().split('T')[0];
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const systemPrompt = TASK_EXTRACTION_PROMPT
        .replace('{{TODAY}}', `${today} (${dayName})`);

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 512,
                system: systemPrompt,
                messages: [{ role: 'user', content: text }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Claude API error: ${response.status} ${errorText}`);
            return [];
        }

        const data = await response.json() as any;
        const content = data.content?.[0]?.text;
        if (!content) return [];

        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            const objMatch = content.match(/\{[\s\S]*\}/);
            if (!objMatch) {
                console.error('No JSON found in AI response');
                return [];
            }
            return [JSON.parse(objMatch[0]) as ExtractedTask];
        }
        const parsed = JSON.parse(jsonMatch[0]);
        return Array.isArray(parsed) ? parsed as ExtractedTask[] : [parsed as ExtractedTask];
    } catch (error) {
        console.error(`Error extracting tasks: ${error}`);
        return [];
    }
}

/** Read clipboard text (cross-platform via clipboardy) */
export function readClipboard(): string {
    try {
        return clipboardy.readSync().trim();
    } catch {
        throw new Error('Failed to read clipboard');
    }
}

export interface ClipboardImage {
    base64: string;
    mediaType: string;
    bytes: number;          /** size of the encoded image */
    width?: number;
    height?: number;
    source?: string;        /** original file name, when the clipboard held a file */
}

/** Claude accepts up to ~5MB per image; stay under it after base64 expansion. */
const MAX_IMAGE_BYTES = 3_500_000;
/** Claude downsamples anything larger, so shrinking here is free. */
const MAX_IMAGE_EDGE = 1568;

// Emits one line: IMAGE|<png path>|<w>|<h>, FILE|<path>|<w>|<h>, or NONE.
// Windows PowerShell (not pwsh) — clipboard access needs an STA thread.
const WIN_CLIP_IMAGE_PS1 = `param([string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Save-Scaled([System.Drawing.Image]$img, [string]$path) {
    $w = $img.Width; $h = $img.Height
    $long = [Math]::Max($w, $h)
    if ($long -gt ${MAX_IMAGE_EDGE}) {
        $scale = ${MAX_IMAGE_EDGE} / $long
        $w = [int][Math]::Round($img.Width * $scale)
        $h = [int][Math]::Round($img.Height * $scale)
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($img, 0, 0, $w, $h)
        $g.Dispose()
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    } else {
        $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    # PNG of a photograph can be huge; fall back to JPEG rather than blowing the API limit.
    if ((Get-Item $path).Length -gt ${MAX_IMAGE_BYTES}) {
        $src = [System.Drawing.Image]::FromFile($path)
        $copy = New-Object System.Drawing.Bitmap($src)
        $src.Dispose()
        $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $prm = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $prm.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85)
        $jpg = [System.IO.Path]::ChangeExtension($path, '.jpg')
        $copy.Save($jpg, $enc, $prm)
        $copy.Dispose()
        Remove-Item $path -Force
        $path = $jpg
    }
    return @($path, $w, $h)
}

if ([Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [Windows.Forms.Clipboard]::GetImage()
    $r = Save-Scaled $img $Out
    $img.Dispose()
    "IMAGE|$($r[0])|$($r[1])|$($r[2])"
} elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $f = [Windows.Forms.Clipboard]::GetFileDropList() |
         Where-Object { $_ -match '\\.(png|jpg|jpeg|gif|webp|bmp|tif|tiff)$' } |
         Select-Object -First 1
    if (-not $f) { 'NONE'; exit }
    $item = Get-Item -LiteralPath $f
    if ($item.Extension -match '^\\.(png|jpg|jpeg|gif|webp)$' -and $item.Length -le ${MAX_IMAGE_BYTES}) {
        "FILE|$($item.FullName)|0|0"
    } else {
        $img = [System.Drawing.Image]::FromFile($item.FullName)
        $r = Save-Scaled $img $Out
        $img.Dispose()
        "IMAGE|$($r[0])|$($r[1])|$($r[2])"
    }
} else {
    'NONE'
}`;

function sniffMediaType(buf: Buffer): string | null {
    if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 6 && buf.toString('latin1', 0, 6).match(/^GIF8[79]a$/)) return 'image/gif';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF'
        && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

function loadImageFile(file: string, width?: number, height?: number, source?: string): ClipboardImage | null {
    const buf = fs.readFileSync(file);
    const mediaType = sniffMediaType(buf);
    if (!mediaType) return null;
    if (buf.length > MAX_IMAGE_BYTES) {
        throw new Error(`Clipboard image is too large (${(buf.length / 1e6).toFixed(1)}MB); crop or resize it first`);
    }
    return {
        base64: buf.toString('base64'),
        mediaType,
        bytes: buf.length,
        width: width || undefined,
        height: height || undefined,
        source
    };
}

/**
 * Read an image from the clipboard (bitmap, or a copied image file).
 * Returns null when the clipboard holds no image or the platform has no
 * helper available. Windows is fully supported; macOS needs `pngpaste`
 * and Linux needs `xclip` or `wl-paste`.
 */
export function readClipboardImage(): ClipboardImage | null {
    const tmp = path.join(os.tmpdir(), `gcal-clip-${process.pid}.png`);
    const cleanup = () => {
        for (const f of [tmp, tmp.replace(/\.png$/, '.jpg')]) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
        }
    };

    try {
        if (process.platform === 'win32') {
            const script = path.join(os.tmpdir(), `gcal-clip-${process.pid}.ps1`);
            fs.writeFileSync(script, WIN_CLIP_IMAGE_PS1, 'utf-8');
            try {
                const out = execFileSync('powershell.exe',
                    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, tmp],
                    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
                const line = out.split(/\r?\n/).filter(Boolean).pop() || 'NONE';
                const [kind, file, w, h] = line.split('|');
                if (kind !== 'IMAGE' && kind !== 'FILE') return null;
                return loadImageFile(file, Number(w), Number(h),
                    kind === 'FILE' ? path.basename(file) : undefined);
            } finally {
                try { fs.unlinkSync(script); } catch { /* ignore */ }
            }
        }

        if (process.platform === 'darwin') {
            // pngpaste exits non-zero when the clipboard has no image.
            execFileSync('pngpaste', [tmp], { stdio: 'ignore' });
            return loadImageFile(tmp);
        }

        // Linux: Wayland first, then X11.
        for (const [cmd, args] of [
            ['wl-paste', ['--type', 'image/png']],
            ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]
        ] as [string, string[]][]) {
            try {
                const buf = execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
                if (!buf.length) continue;
                fs.writeFileSync(tmp, buf);
                return loadImageFile(tmp);
            } catch { /* try the next tool */ }
        }
        return null;
    } catch (err) {
        // "too large" is actionable; anything else means no image is available.
        if (err instanceof Error && err.message.includes('too large')) throw err;
        return null;
    } finally {
        cleanup();
    }
}
