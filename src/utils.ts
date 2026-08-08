export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
}

// Flatten any chat component (ChatMessage / plain JSON component) to its text.
// Concatenates every text source (`.text`, legacy `.json['']` / `['']`, and all
// nested `extra`/`with` children) because components routinely pair an empty or
// partial `.text` with the real content in `extra`. ChatMessage.toString() is a
// last resort.
function extractComponentText(comp: any): string {
    if (comp == null) return '';
    if (typeof comp === 'string') return comp;
    let out = '';
    if (typeof comp.text === 'string') out += comp.text;
    if (comp.json && typeof comp.json === 'object' && typeof comp.json[''] === 'string') out += comp.json[''];
    if (typeof comp[''] === 'string') out += comp[''];
    for (const key of ['extra', 'with']) {
        const parts = comp[key];
        if (Array.isArray(parts)) {
            for (const p of parts) out += extractComponentText(p);
        }
    }
    if (!out && typeof comp.toString === 'function') {
        try { const s = comp.toString(); if (s) return s; } catch {}
    }
    return out;
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

    // (3) Rendered-text fallback
    const text = jsonMsg.toString?.() ?? (typeof jsonMsg === 'string' ? jsonMsg : '');
    if (!text) return null;
    const m = text.match(/^<([^>]+)>\s*(.*)/);
    if (!m) return null;
    const username = m[1].trim();
    const message = m[2].trim();
    if (!message || username === botUsername) return null;
    return { username, message };
}