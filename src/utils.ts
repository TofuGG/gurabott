export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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