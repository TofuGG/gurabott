/**
 * connection.ts - Connection lifecycle and reconnect manager
 */

import { addLog } from './tui.js';
import { sleep } from '../utils.js';

export type ReconnectConfig = {
    maxAttempts: number;
    delayMs: number;
    onReconnect: () => void;
    onGiveUp: () => void;
};

let _attempts = 0;
let _reconnecting = false;
let _disconnecting = false;
let _cfg: ReconnectConfig | null = null;

export function initReconnect(cfg: ReconnectConfig): void {
    _cfg = cfg;
    _attempts = 0;
}

export function resetReconnectAttempts(): void {
    _attempts = 0;
    _reconnecting = false;
}

export function isReconnecting(): boolean { return _reconnecting; }
export function isDisconnecting(): boolean { return _disconnecting; }
export function setDisconnecting(v: boolean): void { _disconnecting = v; }

export async function triggerReconnect(): Promise<void> {
    if (!_cfg) return;
    if (_reconnecting || _disconnecting) return;
    _reconnecting = true;

    _attempts++;

    if (_attempts > _cfg.maxAttempts) {
        addLog('error', `Max reconnect attempts (${_cfg.maxAttempts}) reached. Giving up.`);
        _reconnecting = false;
        _cfg.onGiveUp();
        return;
    }

    addLog('warn', `Reconnecting (${_attempts}/${_cfg.maxAttempts}) in ${_cfg.delayMs / 1000}s...`);
    await sleep(_cfg.delayMs);
    _reconnecting = false;
    _cfg.onReconnect();
}
