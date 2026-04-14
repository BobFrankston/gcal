/**
 * Shared OAuth + HTTP plumbing for gcal and gtask.
 *
 * Both CLIs request the same combined scope set (Calendar + Tasks) so a single
 * consent and a single token file pair (read / write) covers both tools.
 */

import fs from 'fs';
import path from 'path';
import { authenticateOAuth } from '@bobfrankston/oauthsupport';
import { CREDENTIALS_FILE, getUserPaths, ensureUserDir, ts } from './gutils.js';

export const SCOPE_READ =
    'https://www.googleapis.com/auth/calendar.readonly '
    + 'https://www.googleapis.com/auth/tasks.readonly';

export const SCOPE_WRITE =
    'https://www.googleapis.com/auth/calendar '
    + 'https://www.googleapis.com/auth/tasks';

let abortController: AbortController | null = null;

export function setupAbortHandler(): AbortController {
    abortController = new AbortController();
    let ctrlCCount = 0;
    process.on('SIGINT', () => {
        ctrlCCount++;
        abortController?.abort();
        if (ctrlCCount >= 2) {
            console.log('\n\nForce exit.');
            process.exit(1);
        }
        console.log('\n\nCtrl+C pressed - aborting... (press again to force exit)');
    });
    return abortController;
}

export function getAbortController(): AbortController | null {
    return abortController;
}

export async function getAccessToken(
    user: string,
    writeAccess = false,
    forceRefresh = false
): Promise<string> {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
        console.error(`\nCredentials file not found: ${CREDENTIALS_FILE}\n`);
        console.error(`gcal/gtask use the same credentials as gcards.`);
        console.error(`Make sure gcards is set up with OAuth credentials first.`);
        console.error(`See: https://github.com/BobFrankston/oauthsupport/blob/master/SETUP-GOOGLE-OAUTH.md`);
        process.exit(1);
    }

    const paths = getUserPaths(user);
    ensureUserDir(user);

    const scope = writeAccess ? SCOPE_WRITE : SCOPE_READ;
    const tokenFileName = writeAccess ? 'token-write.json' : 'token.json';
    const tokenFilePath = path.join(paths.userDir, tokenFileName);

    if (forceRefresh && fs.existsSync(tokenFilePath)) {
        fs.unlinkSync(tokenFilePath);
        console.log(`${ts()} Token expired, refreshing...`);
    }

    const token = await authenticateOAuth(CREDENTIALS_FILE, {
        scope,
        tokenDirectory: paths.userDir,
        tokenFileName,
        credentialsKey: 'installed',
        signal: abortController?.signal
    });

    if (!token) {
        throw new Error('OAuth authentication failed');
    }

    return token.access_token;
}

export async function apiFetch(
    url: string,
    accessToken: string,
    options: RequestInit = {}
): Promise<Response> {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    return fetch(url, { ...options, headers });
}
