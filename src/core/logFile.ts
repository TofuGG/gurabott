/**
 * logFile.ts — Persistent file logging sink.
 *
 * Each bot run appends every LogEntry as a single JSON line to:
 *   - logs/<YYYY-MM-DD-HH-mm-ss-SSS>-<username>.log  (per-run archive)
 *   - logs/Latest_Log.txt                            (mirror of the current run)
 *
 * Retention: on startup, per-run files older than the newest KEEP_LAST_N are
 * pruned (filenames are timestamp-prefixed, so lexical order == chronological).
 * Latest_Log.txt is truncated at startup and mirrors the running instance.
 *
 * Everything is synchronous (appendFileSync) so log lines are never dropped
 * even across rapid bursts; the writes are small. If a write ever fails the
 * sink disables itself and reports once instead of throwing per line.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { onLog, addLog, type LogEntry } from './store.ts';

export const KEEP_LAST_N = 10;
export const LATEST_FILE = 'Latest_Log.txt';

// src/core -> src -> repo root
export const LOGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `<YYYY-MM-DD-HH-mm-ss-SSS>-<username>.log` — Windows-safe (no colons). */
export function buildRunFileName(now: Date, username: string): string {
    const stamp =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}` +
        `-${pad(now.getMilliseconds(), 3)}`;
    const safeUser = (username || 'bot').replace(/[^A-Za-z0-9_-]/g, '_');
    return `${stamp}-${safeUser}.log`;
}

/** One log line: JSON so multi-line text and quotes survive a round-trip. */
export function formatLogLine(entry: LogEntry): string {
    return `${JSON.stringify(entry)}\n`;
}

function pruneOldRunFiles(): void {
    let files: string[];
    try {
        files = fs.readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.log') && f !== LATEST_FILE)
            .sort();
    } catch {
        return;
    }
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_LAST_N))) {
        try { fs.unlinkSync(path.join(LOGS_DIR, old)); } catch {}
    }
}

let runPath: string | null = null;
let latestPath: string | null = null;
let disabled = false;

function writeLine(entry: LogEntry): void {
    if (!runPath || !latestPath || disabled) return;
    const line = formatLogLine(entry);
    try {
        fs.appendFileSync(runPath, line, 'utf-8');
        fs.appendFileSync(latestPath, line, 'utf-8');
    } catch (err: any) {
        // Stop hammering on every subsequent log line if the disk is unwritable.
        disabled = true;
        try { addLog('warn', `[LOG] File logging disabled: ${err?.message ?? err}`); } catch {}
    }
}

/** Start file logging. Returns an unsubscribe that detaches the sink. */
export function initFileLogging(username: string): () => void {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (err: any) {
        try { addLog('warn', `[LOG] Could not create logs dir: ${err?.message ?? err}`); } catch {}
        return () => {};
    }

    pruneOldRunFiles();

    runPath = path.join(LOGS_DIR, buildRunFileName(new Date(), username));
    latestPath = path.join(LOGS_DIR, LATEST_FILE);
    try {
        fs.writeFileSync(runPath, '', 'utf-8');
        fs.writeFileSync(latestPath, '', 'utf-8');
    } catch (err: any) {
        try { addLog('warn', `[LOG] Could not create log file: ${err?.message ?? err}`); } catch {}
        runPath = null;
        latestPath = null;
        return () => {};
    }

    const unsub = onLog(writeLine);

    writeLine({
        ts: Date.now(),
        type: 'system',
        text: `--- Gurabott run started ${new Date().toISOString()} (user: ${username}) ---`,
    });

    return () => {
        unsub();
        runPath = null;
        latestPath = null;
    };
}
