import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import type { BotMode } from './modules/mode.ts';
import { parseMode } from './modules/mode.ts';
import type { GuiConfig } from './modules/gui.ts';

export interface BotConfig {
    client: {
        host: string;
        port: string;
        username: string;
    };
    ai: {
        enabled: boolean;
        apiKey: string;
        maxTokens: number;
    };
    auth: {
        enabled: boolean;
        password: string;
        mode: 'command' | 'gui' | 'anvil' | 'dialog' | 'both';
        debugWindows: boolean;
        gui: {
            titleMatch: string[];
            slotMap: Record<string, number>;
            clickDelayMs: number;
        };
    };
    greeting: boolean;
    autoReconnect: boolean;
    behaviorMode: BotMode;
    guardrails: boolean;
    mcp: {
        enabled: boolean;
        host: string;
        port: number;
    };
    action: {
        retryDelay: number;
    };
    gui: GuiConfig;
}

// Resolved relative to this file's own location (repo root, one level up
// from src/), not process.cwd() — so it works no matter what directory the
// process is launched from.
const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

// Template for the auto-created allowlist. The "//" note and "_example"
// entries are documentation only — the loader only reads the "allowedUsers"
// array, so examples are effectively commented out.
const ALLOWED_USERS_TEMPLATE: Record<string, unknown> = {
    '//': 'Only these Minecraft usernames can use g-commands (case-insensitive). Add yours to allowedUsers, e.g. "Notch". Shell and MCP are always allowed. Entries under _example are inactive.',
    allowedUsers: [],
    _example: ['Notch', 'Steve'],
};

/**
 * Lazily load a JSON file from the repo root. Used by createBot() after the
 * interactive setup has guaranteed the files exist on disk.
 */
export function loadJson<T>(relativePath: string): T {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relativePath);
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as T;
}

/** Persist an arbitrary JSON value to a repo-root file (e.g. toggling guardrails). */
export function saveJson(relativePath: string, data: unknown): void {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relativePath);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * Load the command allowlist from allowedUser.json — either a plain JSON array
 * of Minecraft usernames or an object with an "allowedUsers" array (any other
 * keys, e.g. a "//" note or "_example" entries, are treated as comments and
 * ignored). Hot-read on every command dispatch so edits apply immediately.
 * Fail-closed: an unreadable or malformed file yields an empty list (only
 * Shell/MCP can dispatch). On first launch the file is auto-created from the
 * example template. Entries are trimmed + lowercased for case-insensitive
 * matching.
 */
export function loadAllowedUsers(): string[] {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'allowedUser.json');
    let raw: string;
    try {
        raw = fs.readFileSync(p, 'utf-8');
    } catch {
        // First launch — create the file with the commented-out example so the
        // operator can see the shape, then behave as an empty list.
        try { fs.writeFileSync(p, JSON.stringify(ALLOWED_USERS_TEMPLATE, null, 4) + '\n'); } catch {}
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }

    let entries: unknown = parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries = (parsed as Record<string, unknown>).allowedUsers;
    }
    if (!Array.isArray(entries)) return [];
    return entries
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

export async function loadConfig(rl: readline.Interface): Promise<BotConfig> {
    let existing: BotConfig | null = null;

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        } catch {
            console.warn('Could not read existing config. Will create new.');
        }
    }

    function ask(question: string): Promise<string> {
        return new Promise((resolve) => rl.question(question, resolve));
    }

    let usePrevious = false;
    if (existing) {
        // Validate existing config has required fields
        if (existing.client) {
            const portNum = parseInt(existing.client.port, 10);
            if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                console.warn(`Invalid port "${existing.client.port}" in config — will reconfigure.`);
                existing.client.port = '25565';
            }
            if (!existing.client.host) existing.client.host = '127.0.0.1';
            if (!existing.client.username) existing.client.username = 'Bot';
        }
        const ans = await ask(`Use previous configuration? (y/n) [y]: `);
        usePrevious = ans.trim().toLowerCase() !== 'n'; // default yes
    }

    let config: BotConfig;
    if (usePrevious && existing) {
        config = existing;
        // Config files saved before the auth feature existed won't have this
        // block — backfill it so initAuth() always gets a well-formed object.
        if (!config.auth) {
            config.auth = {
                enabled: false,
                password: '',
                mode: 'command',
                debugWindows: false,
                gui: { titleMatch: ['login', 'register', 'authme'], slotMap: {}, clickDelayMs: 500 },
            };
        }
        if (config.greeting === undefined) config.greeting = true;
        if (config.autoReconnect === undefined) config.autoReconnect = true;
        if (config.behaviorMode === undefined) config.behaviorMode = 'idle';
        config.behaviorMode = parseMode(config.behaviorMode);
        if (config.guardrails === undefined) config.guardrails = true;
        if (!config.mcp) {
            config.mcp = { enabled: true, host: '127.0.0.1', port: 5400 };
        }
        if (!config.action) {
            config.action = { retryDelay: 5000 };
        }
        if (!config.gui) {
            config.gui = { debugWindows: false, profiles: {} };
        }
        if (config.gui.autoGsdrop === undefined) config.gui.autoGsdrop = true;
        if (config.gui.autoSell === undefined) config.gui.autoSell = true;
        // Persist the backfilled config so bot.ts's loadJson() (which re-reads
        // the file from disk) sees the same fixes instead of a stale legacy
        // file that still crashes createBot (e.g. missing action.retryDelay).
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
    } else {
        const host = (await ask(`Enter server IP [${existing?.client.host ?? '127.0.0.1'}]: `)) || existing?.client.host || '127.0.0.1';
        const port = (await ask(`Enter server port [${existing?.client.port ?? '25565'}]: `)) || existing?.client.port || '25565';
        const username = (await ask(`Enter bot username [${existing?.client.username ?? 'Bot'}]: `)) || existing?.client.username || 'Bot';
        const aiDefault = existing?.ai?.enabled ?? false;
        const aiAns = (await ask(`Enable AI features? (y/n) [${aiDefault ? 'y' : 'n'}]: `)).trim().toLowerCase();
        const enableAI = aiAns === '' ? aiDefault : aiAns === 'y';
        const apiKey = enableAI 
            ? (await ask(`Enter Groq API key [${existing?.ai?.apiKey ? '***' : 'YOUR_GROQ_API'}]: `)) || existing?.ai?.apiKey || 'YOUR_GROQ_API'
            : 'YOUR_GROQ_API';

        const authDefault = existing?.auth?.enabled ?? false;
        const authAns = (await ask(`Does this server require a /login password? (y/n) [${authDefault ? 'y' : 'n'}]: `)).trim().toLowerCase();
        const enableAuth = authAns === '' ? authDefault : authAns === 'y';
        const greetingDefault = existing?.greeting ?? true;
        const greetingAns = (await ask(`Enable player greeting on join? (y/n) [${greetingDefault ? 'y' : 'n'}]: `)).trim().toLowerCase();
        const enableGreeting = greetingAns === '' ? greetingDefault : greetingAns === 'y';
        const reconnectDefault = existing?.autoReconnect ?? true;
        const reconnectAns = (await ask(`Automatically reconnect after disconnects? (y/n) [${reconnectDefault ? 'y' : 'n'}]: `)).trim().toLowerCase();
        const enableReconnect = reconnectAns === '' ? reconnectDefault : reconnectAns === 'y';
        const behaviorModeDefault = existing?.behaviorMode ?? 'idle';
        const modeAns = (await ask(`Default behavior mode on join — idle / attack / free [${behaviorModeDefault}]: `)).trim().toLowerCase();
        const behaviorMode: BotMode = modeAns === '' ? behaviorModeDefault : (['idle', 'attack', 'free'].includes(modeAns) ? modeAns as BotMode : behaviorModeDefault);
        const authPassword = enableAuth
            ? (await ask(`Enter login password [${existing?.auth?.password ? '***' : ''}]: `)) || existing?.auth?.password || ''
            : (existing?.auth?.password ?? '');
        let authMode: BotConfig['auth']['mode'] = existing?.auth?.mode ?? 'command';
        if (enableAuth) {
            const modeAns = (await ask(`Login method — command / gui / anvil / dialog / both [${authMode}]: `)).trim().toLowerCase();
            if (modeAns === 'command' || modeAns === 'gui' || modeAns === 'anvil' || modeAns === 'dialog' || modeAns === 'both') {
                authMode = modeAns;
            }
        }

        config = {
            client: { host, port, username },
            ai: {
                enabled: enableAI,
                apiKey,
                maxTokens: existing?.ai?.maxTokens ?? 150
            },
            auth: {
                enabled: enableAuth,
                password: authPassword,
                mode: authMode,
                debugWindows: existing?.auth?.debugWindows ?? false,
                gui: existing?.auth?.gui ?? {
                    titleMatch: ['login', 'register', 'authme'],
                    slotMap: {},
                    clickDelayMs: 500,
                },
            },
            greeting: enableGreeting,
            autoReconnect: enableReconnect,
            behaviorMode,
            guardrails: existing?.guardrails ?? true,
            mcp: existing?.mcp ?? {
                enabled: true,
                host: '127.0.0.1',
                port: 5400,
            },
            action: existing?.action ?? {
                retryDelay: 5000
            },
            gui: existing?.gui ?? {
                debugWindows: false,
                profiles: {},
            },
        };

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('New configuration saved to', CONFIG_FILE);
    }

    // Do NOT close rl here
    return config;
}