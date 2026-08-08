/**
 * theme.ts — Color tokens for the OpenTUI interface, modelled on the
 * opencode split-footer theme system but adapted to the bot's needs.
 *
 * Palette is a GitHub-dark style: muted neutrals for chrome, distinct hues
 * per log kind and per bot state, and threshold helpers for HP/food bars.
 * All values are hex ColorInputs accepted by @opentui/core.
 */
import type { LogType } from '../core/store.ts';

export const theme = {
    background: '#0d1117',

    // Header status bar
    header: {
        bg: '#161b22',
        border: '#30363d',
        text: '#e6edf3',
        muted: '#8b949e',
        accent: '#58a6ff',
        success: '#3fb950',
        warning: '#d29922',
        error: '#f85149',
    },

    // Footer chrome
    footer: {
        bg: '#161b22',
        border: '#30363d',
        text: '#e6edf3',
        muted: '#8b949e',
        prompt: '#7ee787',
        hint: '#484f58',
    },

    // Main scrollback surface
    scrollback: {
        bg: '#0d1117',
        border: '#21262d',
        separator: '#21262d',
        timestamp: '#6e7681',
    },

    // Log entry kinds
    entry: {
        chat:     '#e6edf3',
        system:   '#58a6ff',
        error:    '#f85149',
        state:    '#d29922',
        ai:       '#bc8cff',
        movement: '#3fb950',
        warn:     '#d29922',
    } as Record<LogType, string>,

    // Bot state colors
    state: {
        idle:       '#3fb950',
        following:  '#58a6ff',
        collecting: '#d29922',
        fleeing:    '#f85149',
        eating:     '#bc8cff',
        sleeping:   '#79c0ff',
        attacking:  '#f85149',
        disconnected: '#8b949e',
    },
} as const;

export type ThemeColors = typeof theme;

/** HP / food bar color by remaining amount (20 max). */
export function vitalityColor(v: number): string {
    if (v > 14) return theme.header.success;
    if (v > 7)  return theme.header.warning;
    return theme.header.error;
}

/** Block bar, e.g. ██████░░░░ */
export function bar(ratio: number, width = 10): string {
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatUptime(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
