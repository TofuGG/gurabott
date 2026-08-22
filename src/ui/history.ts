/**
 * history.ts — disk-backed command history for the footer prompt.
 *
 * The footer keeps an in-memory ring of commands for ↑/↓ recall; this module
 * makes that ring survive restarts by persisting it to command-history.json
 * in the repo root. Loaded lazily on TUI startup, saved on every submit.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolved relative to this file's own location (repo root, one level up
// from src/), same convention as config.ts — works no matter what directory
// the process is launched from.
const HISTORY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'command-history.json');

/**
 * Load persisted command history. Returns [] when the file is missing or
 * malformed so a bad/missing file never breaks the prompt.
 */
export function loadHistory(historyFile: string = HISTORY_FILE): string[] {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        if (Array.isArray(parsed)) {
            return parsed.filter((entry): entry is string => typeof entry === 'string');
        }
    } catch {
        // Missing or corrupt history file — start with an empty ring.
    }
    return [];
}

/** Persist the current command history ring. Best-effort: I/O failure is not fatal. */
export function saveHistory(entries: string[], historyFile: string = HISTORY_FILE): void {
    try {
        fs.writeFileSync(historyFile, JSON.stringify(entries, null, 2));
    } catch {
        // Disk write failure must not crash the prompt.
    }
}
