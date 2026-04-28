/**
 * AI-powered event extraction for gcal
 * Uses Anthropic Claude to parse natural language event descriptions
 * Shares API keys with gcards (%APPDATA%\gcards\keys.env)
 */

import fs from 'fs';
import path from 'path';
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
}

const EVENT_EXTRACTION_PROMPT = `Extract calendar event details from the user's text and return ONLY valid JSON.

Today's date is {{TODAY}}. The user's local timezone is {{TIMEZONE}}.

The text may describe one or multiple events. Always return a JSON array of event objects.

Output format:
[
  {
    "summary": "Event title",
    "startDateTime": "YYYY-MM-DDTHH:mm:ss",
    "duration": "1h",
    "timeZone": "IANA timezone",
    "location": "optional location",
    "description": "optional description"
  }
]

Rules:
- summary: concise event title
- startDateTime: ISO format, resolve relative dates (tomorrow, next Friday, etc.) using today's date
- duration: format as "Xh", "Xm", or "XhYm" (default "1h" if not specified)
- timeZone: IANA timezone (e.g. "America/New_York"). Infer from location if the event is in a different timezone than the user. Default to the user's local timezone if unclear.
- location: include if mentioned, omit if not
- description: include extra details if any, omit if none
- Return ONLY the JSON array, no markdown, no explanation`;

export async function extractEventsFromText(text: string): Promise<ExtractedEvent[]> {
    const apiKey = await ensureAnthropicKey();
    if (!apiKey) return [];

    const today = new Date().toISOString().split('T')[0];
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const systemPrompt = EVENT_EXTRACTION_PROMPT
        .replace('{{TODAY}}', `${today} (${dayName})`)
        .replace('{{TIMEZONE}}', localTz);

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
                messages: [{
                    role: 'user',
                    content: text
                }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Claude API error: ${response.status} ${errorText}`);
            return null;
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
