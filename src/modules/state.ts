/**
 * state.ts - Centralized bot state management
 * Single source of truth for bot state, with typed transitions and listeners.
 */

import type { Bot } from 'mineflayer';

export enum BotState {
    IDLE      = 'idle',
    FOLLOWING = 'following',
    COLLECTING = 'collecting',
    FLEEING   = 'fleeing',
    EATING    = 'eating',
    SLEEPING  = 'sleeping',
    ATTACKING = 'attacking',
}

type StateListener = (prev: BotState, next: BotState) => void;

let _currentState: BotState = BotState.IDLE;
const _listeners: StateListener[] = [];
let _botRef: Bot | null = null;

export function attachBot(bot: Bot): void {
    _botRef = bot;
}

export function getState(): BotState {
    return _currentState;
}

export function setState(newState: BotState): void {
    if (_currentState === newState) return;
    const prev = _currentState;
    _currentState = newState;
    for (const fn of _listeners) {
        try { fn(prev, newState); } catch {}
    }
    // Cancel pathfinding & controls on most transitions
    if (_botRef) {
        try { (_botRef as any).pathfinder?.setGoal(null); } catch {}
        clearAllControls(_botRef);
    }
}

export function onStateChange(fn: StateListener): () => void {
    _listeners.push(fn);
    return () => {
        const idx = _listeners.indexOf(fn);
        if (idx !== -1) _listeners.splice(idx, 1);
    };
}

export function clearAllControls(bot: Bot): void {
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
    for (const c of controls) {
        try { bot.setControlState(c, false); } catch {}
    }
}

export function resetState(): void {
    _currentState = BotState.IDLE;
    _botRef = null;
}
