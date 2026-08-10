export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Log timestamp timezone ────────────────────────────────────────────────────
// On-screen and file-log timestamps render in this fixed offset. "Etc/GMT-6"
// is the IANA name for UTC+6 (Etc/* zone names use inverted signs).
export const LOG_TIME_ZONE = 'Etc/GMT-6';

/** `HH:MM:SS` in LOG_TIME_ZONE for a log entry's epoch-ms timestamp. */
export function formatLogTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, timeZone: LOG_TIME_ZONE });
}

/** `YYYY-MM-DD HH:MM:SS` in LOG_TIME_ZONE for a log entry's epoch-ms timestamp. */
export function formatLogDateTime(ts: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: LOG_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Natural "typed message" delay for an outgoing chat line, proportional to
 * its length. Floored so even tiny messages get a small human pause; capped
 * so long messages don't hang the chat for ages.
 */
export function typingDelayMs(length: number, min = 250, max = 2500, msPerChar = 45): number {
    return Math.min(max, Math.max(min, length * msPerChar));
}

/**
 * Race `p` against a hard deadline. If the deadline wins, `onTimeout` is
 * invoked (e.g. to cancel an in-flight baritone path) and the promise rejects.
 * Guards long-running async work that can otherwise hang forever — baritone's
 * goto() always RESOLVES (it never rejects) but its path-execution promise can
 * stall indefinitely when the goal is unreachable, and bot.dig()/equip() have
 * no built-in timeout.
 */
export function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    onTimeout?: () => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => {
            try { onTimeout?.(); } catch {}
            reject(new Error(`Timed out after ${ms}ms`));
        }, ms);
        p.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
        );
    });
}

/**
 * A single hardened baritone navigation: cancel any stale in-flight path, then
 * go with a hard deadline that stops the path on timeout, and NEVER throw —
 * returns baritone's own `{ status, error }` shape.
 *
 * Required because baritone's goto() never rejects (a failed/unreachable path
 * still RESOLVES with status "failed", and a stalled execution promise can
 * otherwise hold the "Already navigating" lock forever, deadlocking every later
 * goto from a command).
 */
export async function safeGoto(
    bot: any,
    goal: any,
    timeoutMs = 12000,
): Promise<{ status: string; error?: any }> {
    try { bot?.ashfinder?.stop?.(); } catch {}
    try {
        const nav: any = await withTimeout(
            bot.ashfinder.goto(goal),
            timeoutMs,
            () => { try { bot.ashfinder.stop(); } catch {} },
        );
        return nav ?? { status: 'failed', error: new Error('no result') };
    } catch (e) {
        return { status: 'failed', error: e };
    }
}

export const getRandom = <T>(arr: T[]): T => {
    if (arr.length === 0) throw new Error('getRandom called with empty array');
    return arr[Math.floor(Math.random() * arr.length)];
};

export interface ParsedChat {
    username: string;
    message: string;
    /** True for private messages (`/msg`, `/tell`, `/w`) aimed at the bot. */
    whisper?: boolean;
}

// Flatten any chat component (ChatMessage / plain JSON component / array of
// components) to its text. Concatenates every text source (`.text`, legacy
// `.json['']` / `['']`, and all nested `extra`/`with` children) because
// components routinely pair an empty or partial `.text` with the real content
// in `extra`. ChatMessage.toString() is a last resort.
function extractComponentText(comp: any): string {
    return flattenChatComponent(comp);
}

/**
 * Pull the sender's name out of a whisper/`/msg` message's first `with` slot.
 * The rendered component text is unreliable — it can carry prefix/suffix
 * styling around the name (e.g. "TheShutIns SushiChan"). The authoritative
 * name lives in `insertion` (vanilla sets it to the bare player name, which is
 * also what a click would insert into `/tell <name> `). Falls back to the
 * flattened text when insertion is absent.
 */
function extractWhisperSender(comp: any): string {
    const insertion = comp?.json?.insertion ?? comp?.insertion;
    if (typeof insertion === 'string') {
        const name = insertion.trim();
        if (name) return name;
    }
    return extractComponentText(comp).trim();
}

/**
 * Like extractComponentText but handles top-level ARRAYS of components (some
 * servers send a chat line as `[{...}, {...}]`) — recurses into every element.
 */
export function flattenChatComponent(comp: any): string {
    if (comp == null) return '';
    if (typeof comp === 'string') return comp;
    if (Array.isArray(comp)) return comp.map(c => flattenChatComponent(c)).join('');
    let out = '';
    if (typeof comp.text === 'string') out += comp.text;
    if (comp.json && typeof comp.json === 'object' && typeof comp.json[''] === 'string') out += comp.json[''];
    if (typeof comp[''] === 'string') out += comp[''];
    for (const key of ['extra', 'with']) {
        const parts = comp[key];
        if (Array.isArray(parts)) {
            for (const p of parts) out += flattenChatComponent(p);
        }
    }
    if (!out && typeof comp.toString === 'function') {
        try { const s = comp.toString(); if (s) return s; } catch {}
    }
    return out;
}

// ── Quiz detection ────────────────────────────────────────────────────────────
// The server posts an hourly quiz: an announce line like
//   [21:42:38] [21:42] [QUIZ] HOURLY RANDOM QUESTION
// optionally followed by the question on the same line:
//   [21:42:38] [21:42] Which food is basically Minecraft premium health insurance?
// (usually the question arrives as its own follow-up chat line).
//
// Only the real announce (with the "HOURLY RANDOM QUESTION" header) starts a
// quiz. Later outcome banners also carry a [QUIZ] tag but NOT that header —
// e.g. "[QUIZ] WE HAVE A WINNER!" / "[QUIZ] Time is up! ..." — and must NOT be
// mistaken for questions, otherwise we waste an AI call answering garbage.

const QUIZ_MARKER = /\[QUIZ\][\s\S]*HOURLY RANDOM QUESTION|HOURLY RANDOM QUESTION[\s\S]*\[QUIZ\]/i;
const TIMESTAMP_TOKEN = /\[\d{1,2}:\d{2}(?::\d{2})?\]/g;

/** Strip `[21:42:38]` / `[21:42]` timestamp prefixes from a chat line. */
export function stripChatTimestamps(text: string): string {
    return text.replace(TIMESTAMP_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Inspect a flattened chat line for the quiz announce. Returns whether it's a
 * quiz line and, if the question is on the same line, the question text.
 * `question: null` means it was just the announce — the question arrives next.
 */
export function parseQuizLine(flat: string): { isQuiz: boolean; question: string | null } {
    if (!QUIZ_MARKER.test(flat)) return { isQuiz: false, question: null };
    const cleaned = stripChatTimestamps(flat)
        .replace(/\[QUIZ\]/gi, ' ')
        .replace(/HOURLY RANDOM QUESTION/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return { isQuiz: true, question: cleaned || null };
}

/**
 * Tpa-related commands the bot must NEVER send — neither accepts (`/tpa
 * accept`, `/tpaccept`, `/tpa yes`) nor requests (`/tpa <player>`,
 * `/tpahere <player>`). Every spelling starts with `tpa` after the slash;
 * `/tpaccept` is listed explicitly for clarity. Deliberately does NOT match
 * `/login`, `/tp <x> <y> <z>` (the gtp command), or plain chat.
 */
const TPA_COMMAND_PATTERN = /\/(?:tpa|tpaccept)/i;

export function isTpaCommand(message: string): boolean {
    return TPA_COMMAND_PATTERN.test(message);
}

/**
 * Profanity the bot must NEVER send. Curated to avoid false positives:
 * `ass` only matches standalone or asshole/asshat/asswipe (so assassin,
 * assist, assigned, assembly, class, pass, grass all pass), and every term
 * needs word boundaries (so hello/hellow etc. pass).
 */
const PROFANITY_PATTERN = /\b(?:fuck(?:ing|er|ed|s|tard)?|motherfuck(?:er|ing)?|shit(?:ty|s)?|bullshit|bitch(?:es|ing|y)?|ass(?:hole|hat|wipe)?|arse(?:hole)?|bastard(?:s)?|dick(?:s|head)?|cock(?:s|sucker)?|pussy|piss(?:ed|ing)?|cunt(?:s)?|whore(?:s)?|slut(?:s)?|twat(?:s)?|nigga|nigger|retard(?:ed)?|hell(?:ish)?|damn(?:ed)?|goddamn|crap(?:py|s)?)\b/i;

export function containsProfanity(message: string): boolean {
    return PROFANITY_PATTERN.test(message);
}

/**
 * Prompt-injection attempts that hijack the bot's lines. Curated to the shapes
 * seen in the wild ("replace X with Y", "every time you speak say...", "from
 * now on...", "you are now...", "ignore previous instructions") so normal
 * player chat about songs, jokes or builds is NOT flagged.
 */
const PROMPT_INJECTION_PATTERNS = [
    // "replace X with Y" / "replace X and Y with Z" / "swap X for Y"
    /\breplace\b[\s\S]{0,80}\bwith\b/i,
    /\bswap\b[\s\S]{0,60}\bfor\b/i,
    // "everytime/every time/whenever/each time you say/speak/talk/reply" —
    // behavior-binding instruction that persists across the bot's future lines
    /\b(?:every\s*time|whenever|each\s+time)\s+(?:you\s+)?(?:speak|say|talk|reply|respond|message)\b/i,
    /\bevery\s+\d+(?:st|nd|rd|th)?\s*seconds?\b/i,
    // "from now on ..." future-behavior binding
    /\bfrom now on\b/i,
    // "always say X" / "never say X" / "stop saying X"
    /\b(?:always|never)\s+(?:say|speak|talk|reply|type)\b/i,
    /\bstop\s+(?:saying|saying\s)/i,
    // identity / instruction overrides
    /\bignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+instructions\b/i,
    /\byou are now\b/i,
    /\byour\s+new\s+(?:name|identity|personality)\b/i,
    /\bpretend\s+(?:to\s+be|you\s+are)\b/i,
    /\bcall\s+yourself\b/i,
    // "every pause with X", "add X to every ..."
    /\bevery\s+pause\b/i,
    /\badd\s+["']?[\w~]+\s+to\s+every\b/i,
] as RegExp[];

export function detectPromptInjection(message: string): boolean {
    if (!message) return false;
    return PROMPT_INJECTION_PATTERNS.some((p) => p.test(message));
}

/**
 * Try to pull the requester's name out of a raw tpa-request chat packet.
 * Most plugins embed it in the click command (`/tpaccept <name>`); some only
 * set the `insertion` field. Returns null when neither is present.
 */
export function extractTpaSender(raw: string): string | null {
    const fromCommand = raw.match(/\/tpaccept\s+([A-Za-z0-9_]+)/i);
    if (fromCommand?.[1]) return fromCommand[1];
    const fromInsertion = raw.match(/"insertion":"([^"]+)"/);
    return fromInsertion?.[1] ?? null;
}

export function parseChatMessage(jsonMsg: any, botUsername: string): ParsedChat | null {
    if (!jsonMsg) return null;

    const withArr = jsonMsg?.with;
    const translate = jsonMsg?.translate;

    // (1) Classic / printf client-side chat: sender + content as with[0]/with[1]
    const isPlayerChat =
        translate === 'chat.type.text' ||
        (typeof translate === 'string' && translate.includes('%1$s') && translate.includes('%2$s'));
    if (isPlayerChat && Array.isArray(withArr) && withArr.length >= 2) {
        const username = extractComponentText(withArr[0]).trim();
        const message = extractComponentText(withArr[1]).trim();
        if (!username || !message || username === botUsername) return null;
        return { username, message };
    }

    // (2) Single-param chat (`%s` + one `with` entry): with[0] is the content
    // and the sender is only recoverable from `unsigned` (the server's original
    // chat), which this server family renders as "Name: message".
    if (translate === '%s' && Array.isArray(withArr) && withArr.length >= 1) {
        const message = extractComponentText(withArr[0]).trim();
        if (!message) return null;
        const unsignedText = extractComponentText(jsonMsg?.unsigned?.with?.[0]).trim();
        const u = unsignedText.match(/^([^:]+):\s*(.*)/);
        const username = u?.[1]?.trim() ?? '';
        if (!username || username === botUsername) return null;
        return { username, message };
    }

    // (3) Private messages (/msg, /tell, /w). Vanilla sends
    // `commands.message.display.incoming` ("<sender> whispers to you: <msg>")
    // with with[0]=sender, with[1]=message; outgoing echoes are the bot's own
    // messages and must be filtered out (they carry the bot's own username).
    if (translate === 'commands.message.display.incoming' && Array.isArray(withArr) && withArr.length >= 2) {
        const sender = extractWhisperSender(withArr[0]);
        const message = extractComponentText(withArr[1]).trim();
        if (!sender || !message || sender === botUsername) return null;
        return { username: sender, message, whisper: true };
    }
    if (translate === 'commands.message.display.outgoing') return null;

    // (4) Rendered-text fallback
    const text = jsonMsg.toString?.() ?? (typeof jsonMsg === 'string' ? jsonMsg : '');
    if (!text) return null;
    const m = text.match(/^<([^>]+)>\s*(.*)/);
    if (!m) return null;
    const username = m[1].trim();
    const message = m[2].trim();
    if (!message || username === botUsername) return null;
    return { username, message };
}