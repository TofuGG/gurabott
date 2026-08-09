/**
 * ai.ts - AI response module using Groq
 * Handles conversation history, rate-limiting, and AI command parsing.
 */

import Groq from 'groq-sdk';
import { sleep } from '../utils.ts';
import { addLog } from '../core/store.ts';
import { BotState, getState } from './state.ts';

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

// The directedness classifier gets its OWN budget so a busy server (which now
// judges every chat message) can never starve actual conversation replies.
// When the classifier is rate-limited it reports "no opinion" and the caller
// falls back to the old heuristic instead of going deaf.
const MAX_CLASSIFY_PER_WINDOW = 20;
const classifyTimestamps: number[] = [];

function isClassifyRateLimited(): boolean {
    const now = Date.now();
    while (classifyTimestamps.length > 0 && classifyTimestamps[0] < now - REQUEST_WINDOW_MS) {
        classifyTimestamps.shift();
    }
    return classifyTimestamps.length >= MAX_CLASSIFY_PER_WINDOW;
}

function recordClassifyRequest(): void {
    classifyTimestamps.push(Date.now());
}

// ── Conversation history ──────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant'; content: string };
const _history: { [player: string]: Message[] } = {};

export function clearHistory(username: string): void {
    delete _history[username];
}

// ── Action parser ─────────────────────────────────────────────────────────────

const ACTION_PREFIXES = [
    'FOLLOW', 'COLLECT', 'SLEEP', 'STOP', 'OPEN_DOOR',
    'DROP_ALL', 'DROP', 'EAT', 'JUMP', 'WALK', 'CROUCH',
] as const;

function isAction(line: string): boolean {
    // Match on the first whitespace-delimited token. The no-arg actions
    // (SLEEP/STOP/OPEN_DOOR/DROP_ALL/WALK) are matched as whole tokens so a
    // chat line like "Stop that!" or "Sleep well" is NOT swallowed as an action
    // and doesn't trigger real bot behavior.
    const [token] = line.split(/\s+/);
    return (ACTION_PREFIXES as readonly string[]).includes(token);
}

function parseLine(line: string): ParsedAction | null {
    const [token, ...rest] = line.split(/\s+/);
    const restText = rest.join(' ');
    switch (token) {
        case 'SLEEP':     return { type: 'SLEEP' };
        case 'STOP':      return { type: 'STOP' };
        case 'OPEN_DOOR': return { type: 'OPEN_DOOR' };
        case 'DROP_ALL':  return { type: 'DROP_ALL' };
        case 'WALK':      return { type: 'WALK' };
        case 'FOLLOW':    return { type: 'FOLLOW',  target: restText };
        case 'COLLECT':   return { type: 'COLLECT', args:   restText };
        case 'DROP':      return { type: 'DROP', item: rest[0] ?? '', amount: parseInt(rest[1] ?? '1', 10) || 1 };
        case 'EAT':       return { type: 'EAT',  item: restText };
        case 'JUMP':      return { type: 'JUMP', amount: parseInt(restText, 10) || 1 };
        case 'CROUCH':    return { type: 'CROUCH', seconds: Math.max(1, parseInt(restText, 10) || 1) };
        default: return null;
    }
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

/**
 * Session 2 — directedness gate. A stateless, single-turn Groq call that
 * answers a strict YES/NO: was this chat message actually directed at the bot
 * (talking to it, asking it something, commanding it)? Conversation (session 1)
 * only runs when this says YES.
 */
export type DirectedCheckConfig = {
    enabled: boolean;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    /** Prompt; may contain the `{botName}` placeholder. */
    prompt: string;
};

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
    directedCheck: DirectedCheckConfig;
    quiz: QuizConfig;
};

/**
 * Hourly-quiz answering. A short, stateless single-turn call that returns just
 * the answer — deliberately separate from the conversation session so a quiz
 * reply never pollutes player chat history or waits on the directedness gate.
 */
export type QuizConfig = {
    enabled: boolean;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    /** System prompt asking for a single short answer. */
    prompt: string;
};

export async function getAIResponse(
    ctx: AIContext,
    username: string,
    message: string,
    trigger: AITrigger,
    stateContext: string,
): Promise<ParsedAIResponse | null> {
    if (isRateLimited()) {
        addLog('warn', '[AI] Rate limit reached, skipping response');
        return null;
    }

    if (!_history[username]) _history[username] = [];
    addLog('ai', `[AI] Request from ${username} (trigger=${trigger}): "${message.slice(0, 50)}"`);

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

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);

        let response;
        try {
            response = await ctx.groq.chat.completions.create({
                model: ctx.model,
                max_tokens: ctx.maxTokens,
                messages: [
                    { role: 'system', content: systemContent },
                    ..._history[username],
                    { role: 'user', content: message },
                ],
            }, { signal: controller.signal as any });
        } finally {
            clearTimeout(timeout);
        }

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
        const msg = err?.name === 'AbortError' ? 'AI request timed out (15s)' : err?.message ?? err;
        addLog('error', `[AI] Groq error: ${msg}`);
        return null;
    }
}

// ── Directedness gate (session 2) ────────────────────────────────────────────

/**
 * Parse the classifier's reply into a verdict. Returns:
 *  - true  → message directed at the bot
 *  - false → not directed
 *  - null  → couldn't tell (ambiguous/empty) → caller falls back to heuristic
 */
export function parseDirectedVerdict(reply: string): boolean | null {
    const trimmed = reply.trim().toUpperCase();
    if (/^YES\b/.test(trimmed)) return true;
    if (/^NO\b/.test(trimmed)) return false;
    return null;
}

/**
 * Build the classifier system prompt, substituting the bot's name into the
 * `{botName}` placeholder. Pure so it's unit-testable.
 */
export function buildDirectedSystemPrompt(basePrompt: string, botName: string): string {
    return basePrompt.replaceAll('{botName}', botName);
}

/**
 * Session 2 — decide whether `message` from `sender` is directed at the bot.
 * Returns `null` (no opinion) when the check is disabled, rate-limited, or the
 * request fails/times out; the caller then falls back to the name-mention /
 * open-window heuristic so the bot never goes deaf on a classifier outage.
 */
export async function isMessageDirected(
    ctx: AIContext,
    botName: string,
    sender: string,
    message: string,
): Promise<boolean | null> {
    if (!ctx.directedCheck.enabled) return null;
    if (isClassifyRateLimited()) {
        addLog('ai', '[AI] Classifier rate limit reached — using heuristic fallback');
        return null;
    }

    const systemContent = buildDirectedSystemPrompt(ctx.directedCheck.prompt, botName);
    addLog('ai', `[AI] Directedness check from ${sender}: "${message.slice(0, 50)}"`);

    try {
        recordClassifyRequest();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ctx.directedCheck.timeoutMs);

        let response;
        try {
            response = await ctx.groq.chat.completions.create({
                model: ctx.directedCheck.model,
                max_tokens: ctx.directedCheck.maxTokens,
                messages: [
                    { role: 'system', content: systemContent },
                    { role: 'user', content: `${sender}: ${message}` },
                ],
            }, { signal: controller.signal as any });
        } finally {
            clearTimeout(timeout);
        }

        const reply = response.choices[0]?.message?.content?.trim() ?? '';
        const verdict = parseDirectedVerdict(reply);
        addLog('ai', `[AI] Directedness verdict (${sender}): ${reply.slice(0, 20)} → ${verdict ?? 'fallback'}`);
        return verdict;
    } catch (err: any) {
        const msg = err?.name === 'AbortError' ? `Classifier timed out (${ctx.directedCheck.timeoutMs}ms)` : err?.message ?? err;
        addLog('error', `[AI] Classifier error: ${msg}`);
        return null;
    }
}

// ── Quiz answering ────────────────────────────────────────────────────────────

/**
 * Answer an hourly-quiz question with a single short reply. Returns the
 * answer text, or null when disabled / failed / timed out.
 */
export async function getQuizAnswer(
    ctx: AIContext,
    question: string,
): Promise<string | null> {
    if (!ctx.quiz.enabled) return null;

    addLog('ai', `[AI] Quiz question: "${question.slice(0, 80)}"`);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ctx.quiz.timeoutMs);

        let response;
        try {
            response = await ctx.groq.chat.completions.create({
                model: ctx.quiz.model,
                max_tokens: ctx.quiz.maxTokens,
                messages: [
                    { role: 'system', content: ctx.quiz.prompt },
                    { role: 'user', content: `Quiz question: ${question}` },
                ],
            }, { signal: controller.signal as any });
        } finally {
            clearTimeout(timeout);
        }

        const answer = response.choices[0]?.message?.content?.trim() ?? '';
        if (!answer) {
            addLog('warn', '[AI] Quiz answer empty');
            return null;
        }
        addLog('ai', `[AI] Quiz answer: "${answer.slice(0, 80)}"`);
        return answer;
    } catch (err: any) {
        const msg = err?.name === 'AbortError' ? `Quiz timed out (${ctx.quiz.timeoutMs}ms)` : err?.message ?? err;
        addLog('error', `[AI] Quiz error: ${msg}`);
        return null;
    }
}
