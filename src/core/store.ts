/**
 * store.ts — Sole event bus + snapshot store between the bot engine and the
 * UI layer.
 *
 * The bot core (bot.ts, movementAI.ts, stuckDetector.ts, commands.ts,
 * survival.ts, auth.ts, ai.ts, connection.ts, index.ts) MUST import logging
 * and state-publishing primitives from here — never from a UI module. The UI
 * layer subscribes to the store and renders.
 *
 * Responsibilities:
 *  - Ring-buffer log store (cap MAX_LOG_ENTRIES) with typed log entries.
 *  - addLog() facade matching the historical `addLog(type, text)` signature so
 *    existing call sites change only their import path.
 *  - Telemetry snapshot store (connection / hp / food / pos / state / ...)
 *    published by the engine and consumed by the UI reactively.
 *  - Console interception (console.log/warn/error -> addLog) so third-party
 *    modules that print land in the same feed.
 *  - Headless fallback: if no UI sink is registered, log lines are written to
 *    stdout so the process remains observable without a TUI.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type LogType = 'chat' | 'system' | 'error' | 'state' | 'ai' | 'movement' | 'warn';

export interface LogEntry {
    type: LogType;
    text: string;
    ts: number;
}

export interface TelemetrySnapshot {
    connected: boolean;
    server: string;
    username: string;
    ping: number;
    players: number;
    hp: number;
    food: number;
    pos: { x: number; y: number; z: number } | null;
    state: string;
    invCount: number;
    aiEnabled: boolean;
    uptime: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_LOG_ENTRIES = 2000;

// ── Log store ─────────────────────────────────────────────────────────────────

let logs: LogEntry[] = [];
const logSinks = new Set<(entry: LogEntry) => void>();

export function addLog(type: LogType, text: string): void {
    const entry: LogEntry = { type, text, ts: Date.now() };
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) {
        logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    }

    if (logSinks.size > 0) {
        for (const sink of logSinks) {
            try { sink(entry); } catch {}
        }
    } else {
        // Headless fallback — no UI attached, keep the process observable.
        try { process.stdout.write(`[${type.toUpperCase()}] ${text}\n`); } catch {}
    }
}

/**
 * Register a log sink (a UI renderer). Returns an unsubscribe function.
 * Multiple sinks are allowed.
 */
export function onLog(fn: (entry: LogEntry) => void): () => void {
    logSinks.add(fn);
    return () => {
        logSinks.delete(fn);
    };
}

export function getLogs(): readonly LogEntry[] {
    return logs;
}

// ── Telemetry snapshot store ──────────────────────────────────────────────────

let telemetry: TelemetrySnapshot | null = null;
const telemetrySubs = new Set<(snap: TelemetrySnapshot) => void>();

export function pushTelemetry(snap: TelemetrySnapshot): void {
    telemetry = snap;
    for (const fn of telemetrySubs) {
        try { fn(snap); } catch {}
    }
}

export function getTelemetry(): TelemetrySnapshot | null {
    return telemetry;
}

export function onTelemetry(fn: (snap: TelemetrySnapshot) => void): () => void {
    telemetrySubs.add(fn);
    return () => { telemetrySubs.delete(fn); };
}

// ── Console interception ──────────────────────────────────────────────────────

/**
 * Redirect console.log/warn/error into the log feed so anything that prints
 * (including third-party libraries) shows up in the TUI. Call once at startup
 * after the TUI is initialized. Idempotent.
 */
export function interceptConsole(): void {
    const fmt = (a: unknown[]): string =>
        a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    console.log   = (...a) => addLog('system', fmt(a));
    console.warn  = (...a) => addLog('warn',   fmt(a));
    console.error = (...a) => addLog('error',  fmt(a));
}
