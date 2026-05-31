/**
 * ai.ts - AI response module using Groq
 * Handles conversation history, rate-limiting, and AI command parsing.
 */

import Groq from 'groq-sdk';
import { sleep } from '../utils.js';
import { addLog } from './tui.js';
import { BotState, getState } from './state.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AITrigger = 'mentioned' | 'chime' | 'solo';

export type ParsedAIResponse = {
    chatText: string;
    actions: ParsedAction[];
};

export type ParsedAction =
    | { type: 'FOLLOW'; target: string }
    | { type: 'COLLECT'; args: string }
    | { type: 'SLEEP' }
    | { type: 'STOP' }
    | { type: 'OPEN_DOOR' }
    | { type: 'DROP_ALL' }
    | { type: 'DROP'; item: string; amount: number }
    | { type: 'EAT'; item: string }
    | { type: 'JUMP'; amount: number }
    | { type: 'WALK' }
    | { type: 'CROUCH'; seconds: number };

// ── Rate limiting ─────────────────────────────────────────────────────────────

const REQUEST_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
    const now = Date.now();
    // Purge old entries
    while (requestTimestamps.length > 0 && requestTimestamps[0] < now - REQUEST_WINDOW_MS) {
        requestTimestamps.shift();
    }
    return requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW;
}

function recordRequest(): void {
    requestTimestamps.push(Date.now());
}

// ── Conversation history ──────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant'; content: string };
const _history: { [player: string]: Message[] } = {};

export function clearHistory(username: string): void {
    delete _history[username];
}

export function getHistorySize(username: string): number {
    return _history[username]?.length ?? 0;
}

// ── Action parser ─────────────────────────────────────────────────────────────

const ACTION_PREFIXES = [
    'FOLLOW ', 'COLLECT ', 'SLEEP', 'STOP', 'OPEN_DOOR',
    'DROP_ALL', 'DROP ', 'EAT ', 'JUMP ', 'WALK', 'CROUCH ',
] as const;

function isAction(line: string): boolean {
    return ACTION_PREFIXES.some(p => line.startsWith(p));
}

function parseLine(line: string): ParsedAction | null {
    if (line === 'SLEEP')      return { type: 'SLEEP' };
    if (line === 'STOP')       return { type: 'STOP' };
    if (line === 'OPEN_DOOR')  return { type: 'OPEN_DOOR' };
    if (line === 'DROP_ALL')   return { type: 'DROP_ALL' };
    if (line === 'WALK')       return { type: 'WALK' };

    if (line.startsWith('FOLLOW '))  return { type: 'FOLLOW',  target: line.slice(7).trim() };
    if (line.startsWith('COLLECT ')) return { type: 'COLLECT', args:   line.slice(8).trim() };

    if (line.startsWith('DROP ')) {
        const parts = line.slice(5).trim().split(' ');
        return { type: 'DROP', item: parts[0] ?? '', amount: parseInt(parts[1] ?? '1') || 1 };
    }
    if (line.startsWith('EAT '))  return { type: 'EAT',  item:    line.slice(4).trim() };
    if (line.startsWith('JUMP ')) return { type: 'JUMP', amount:  parseInt(line.slice(5).trim()) || 1 };
    if (line.startsWith('CROUCH ')) {
        const secs = Math.max(1, parseInt(line.slice(7).trim()) || 1);
        return { type: 'CROUCH', seconds: secs };
    }
    return null;
}

export function parseAIReply(reply: string): ParsedAIResponse {
    const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
    const actions: ParsedAction[] = [];
    const chatLines: string[] = [];

    for (const line of lines) {
        if (isAction(line)) {
            const action = parseLine(line);
            if (action) actions.push(action);
        } else {
            chatLines.push(line);
        }
    }

    return { chatText: chatLines.join(' ').trim(), actions };
}

// ── Main AI call ──────────────────────────────────────────────────────────────

export type AIContext = {
    groq: Groq;
    model: string;
    maxTokens: number;
    systemPrompt: string;
    aiCommands: string[];
    responseFormat: string;
    chimeDuration: string;
    glitchMessage: string;
    maxHistoryPerPlayer: number;
};

export async function getAIResponse(
    ctx: AIContext,
    username: string,
    message: string,
    trigger: AITrigger,
    stateContext: string,
): Promise<ParsedAIResponse | null> {
    if (isRateLimited()) {
        addLog('warn', 'AI rate limit reached, skipping response');
        return null;
    }

    if (!_history[username]) _history[username] = [];

    const delay = trigger === 'chime' ? 3000 : 800;
    await sleep(delay);

    try {
        recordRequest();
        const chimeNote = trigger === 'chime' ? ctx.chimeDuration : '';
        const systemContent = [
            ctx.systemPrompt,
            stateContext,
            '',
            'Commands (use ONLY these, exact spelling):',
            ctx.aiCommands.join('\n'),
            '',
            ctx.responseFormat,
            chimeNote,
        ].filter(Boolean).join('\n');

        const response = await ctx.groq.chat.completions.create({
            model: ctx.model,
            max_tokens: ctx.maxTokens,
            messages: [
                { role: 'system', content: systemContent },
                ..._history[username],
                { role: 'user', content: message },
            ],
        });

        const reply = response.choices[0]?.message?.content?.trim() ?? '';

        // Update history
        _history[username].push(
            { role: 'user', content: message },
            { role: 'assistant', content: reply },
        );

        // Trim history
        if (_history[username].length > ctx.maxHistoryPerPlayer) {
            _history[username] = _history[username].slice(-ctx.maxHistoryPerPlayer);
        }

        addLog('ai', `[${username}→AI] "${message.slice(0, 40)}" → "${reply.slice(0, 60)}"`);

        return parseAIReply(reply);

    } catch (err: any) {
        addLog('error', `Groq error: ${err?.message ?? err}`);
        return null;
    }
}
