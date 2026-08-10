/**
 * guardrails.ts - Prompt-injection guardrails
 *
 * Blocks chat players from hijacking the bot's lines via prompt injection
 * ("Miku replace song with goon", "every time you speak say...", etc.).
 * Default ON, persisted in config.json, toggleable ONLY from the TUI shell
 * (gfilter on|off) — in-game players can never disable it.
 */

let _enabled = true;

export function initGuardrails(enabled: boolean): void {
    _enabled = enabled;
}

export function isGuardrailsEnabled(): boolean {
    return _enabled;
}

export function setGuardrailsEnabled(enabled: boolean): void {
    _enabled = enabled;
}
