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

export function parseChatMessage(jsonMsg: any, botUsername: string): ParsedChat | null {
    if (!jsonMsg) return null;

    const withArr = jsonMsg?.with;
    const translate = jsonMsg?.translate;

    if (translate === 'chat.type.text' && Array.isArray(withArr) && withArr.length >= 2) {
        const senderObj = withArr[0];
        const messageObj = withArr[1];
        const username = senderObj?.text ?? String(senderObj ?? '');
        let message = '';

        if (typeof messageObj === 'string') {
            message = messageObj;
        } else if (messageObj?.text) {
            message = messageObj.text;
        } else if (messageObj?.json && typeof messageObj.json === 'object') {
            message = messageObj.json[''] ?? '';
        } else if (messageObj?.extra) {
            message = messageObj.extra.map((e: any) => e.text ?? '').join('');
        } else if (typeof messageObj?.[''] === 'string') {
            message = messageObj[''];
        }

        if (!message || !username || username === botUsername) return null;
        return { username, message: message.trim() };
    }

    const text = jsonMsg.toString?.() ?? '';
    if (!text) return null;
    const m = text.match(/^<([^>]+)>\s*(.*)/);
    if (!m) return null;
    const username2 = m[1];
    const message2 = m[2];
    if (!message2 || username2 === botUsername) return null;
    return { username: username2, message: message2 };
}