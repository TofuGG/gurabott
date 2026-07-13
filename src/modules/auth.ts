/**
 * auth.ts - AuthMe-style server login
 *
 * Handles three login styles, selectable via config.auth.mode:
 *   - "command": sends `/login <password>` (and `/register` as a fallback)
 *                as a normal chat message. Works for the vast majority of
 *                AuthMe/AuthMeReloaded setups, even ones that also show a GUI.
 *   - "anvil":   for servers whose "GUI" is really an anvil-rename screen —
 *                the bot "types" the password by renaming the anvil's input
 *                item, then clicks the output slot to submit.
 *   - "gui":     for custom chest/inventory keypads. Clicks a sequence of
 *                slots (one per password character, from config.auth.gui.slotMap)
 *                followed by an optional "confirm" slot.
 *   - "both":    runs the command AND whichever GUI strategy applies.
 *
 * Every server's custom login GUI is different, so config.auth.debugWindows
 * lets you first log the title/type/slots of whatever window opens, so you
 * can fill in config.auth.gui.slotMap yourself before enabling "gui"/"anvil".
 */

import type { Bot } from 'mineflayer';
import { addLog } from './tui.ts';
import { sleep } from '../utils.ts';

export interface GuiAuthConfig {
    // Substrings (case-insensitive) checked against the window title to
    // decide whether a freshly-opened window is the login/register screen.
    titleMatch: string[];
    // Maps password characters ("0".."9", letters, symbols) and the special
    // keys "confirm"/"output" to the slot index that types/submits them.
    // Fill this in after running with debugWindows:true and reading the log.
    slotMap: Record<string, number>;
    // Delay between each click, in ms. Too fast and some servers drop clicks.
    clickDelayMs: number;
}

export interface AuthConfig {
    enabled: boolean;
    password: string;
    mode: 'command' | 'gui' | 'anvil' | 'both';
    debugWindows: boolean;
    gui: GuiAuthConfig;
}

// Some servers send the window title as a JSON chat component
// (e.g. {"text":"Login"}) instead of a plain string. Handle both.
function titleToPlainText(title: unknown): string {
    if (typeof title !== 'string') return String(title ?? '');
    try {
        const parsed = JSON.parse(title);
        if (parsed && typeof parsed === 'object') {
            return parsed.text ?? title;
        }
    } catch {
        // Not JSON — already plain text.
    }
    return title;
}

function isAuthWindow(title: string, titleMatch: string[]): boolean {
    const t = title.toLowerCase();
    return titleMatch.some(m => t.includes(m.toLowerCase()));
}

// Logs every slot in a freshly-opened window so you can find which slot
// number corresponds to which digit/letter/button in your server's GUI.
function logWindowSlots(window: any): void {
    const title = titleToPlainText(window.title);
    addLog('system', `[auth-debug] window opened — id=${window.id} type=${window.type} title="${title}"`);
    window.slots.forEach((item: any, index: number) => {
        if (!item) return;
        const custom = item.customName ? ` custom="${item.customName}"` : '';
        addLog('system', `[auth-debug]   slot ${index}: ${item.name} (${item.displayName})${custom}`);
    });
}

async function clickSlots(bot: Bot, slots: number[], delayMs: number): Promise<void> {
    for (const slot of slots) {
        try {
            await bot.clickWindow(slot, 0, 0);
        } catch (err: any) {
            addLog('error', `[auth] click on slot ${slot} failed: ${err?.message ?? err}`);
        }
        await sleep(delayMs);
    }
}

async function runGuiLogin(bot: Bot, cfg: AuthConfig): Promise<void> {
    const { slotMap, clickDelayMs } = cfg.gui;
    const chars = cfg.password.split('');
    const slots = chars.map(c => slotMap[c]);

    if (slots.some(s => s === undefined)) {
        addLog('warn', '[auth] password has characters with no slot in config.auth.gui.slotMap — '
            + 'enable debugWindows, open the login GUI once, and read the slot numbers from the log.');
        return;
    }

    await clickSlots(bot, slots as number[], clickDelayMs);

    if (slotMap.confirm !== undefined) {
        await sleep(clickDelayMs);
        await clickSlots(bot, [slotMap.confirm], clickDelayMs);
    }
    addLog('system', '[auth] submitted password via GUI clicks');
}

async function runAnvilLogin(bot: Bot, cfg: AuthConfig): Promise<void> {
    try {
        // Anvil "type the password" screens work by renaming the input item;
        // this is the same packet the vanilla client sends while you type in
        // the anvil's text box.
        (bot as any)._client.write('name_item', { name: cfg.password });
        await sleep(cfg.gui.clickDelayMs || 300);
        // Slot 2 is the anvil's output slot by default; override via
        // config.auth.gui.slotMap.output if your server's layout differs.
        const outputSlot = cfg.gui.slotMap.output ?? 2;
        await bot.clickWindow(outputSlot, 0, 0);
        addLog('system', '[auth] submitted password via anvil rename');
    } catch (err: any) {
        addLog('error', `[auth] anvil login failed: ${err?.message ?? err}`);
    }
}

export function initAuth(bot: Bot, cfg: AuthConfig): void {
    if (!cfg.enabled) return;

    if (cfg.mode === 'command' || cfg.mode === 'both') {
        // IMPORTANT: this must be 'login', not 'spawn'. mineflayer's 'spawn'
        // event only fires after the bot receives a health packet from the
        // server — and AuthMe-gated servers deliberately withhold that
        // packet (freezing you in limbo) until you've already authenticated.
        // Waiting for 'spawn' here would deadlock: the bot waits for spawn
        // to send /login, while the server waits for /login before it will
        // ever send the packet that triggers spawn. 'login' fires immediately
        // on join (the join_game packet), before any authentication.
        bot.once('login', () => {
            setTimeout(() => {
                try {
                    bot.chat(`/login ${cfg.password}`);
                    addLog('system', '[auth] sent /login command');
                } catch (err: any) {
                    addLog('error', `[auth] failed to send /login: ${err?.message ?? err}`);
                }
            }, 1000);
        });
    }

    bot.on('windowOpen', async (window: any) => {
        if (cfg.debugWindows) logWindowSlots(window);

        if (cfg.mode === 'command') return;

        const title = titleToPlainText(window.title);
        const isAnvil = window.type === 'minecraft:anvil' || window.type === 'anvil';
        const matchesConfiguredTitle = isAuthWindow(title, cfg.gui.titleMatch);
        if (!isAnvil && !matchesConfiguredTitle) return;

        addLog('system', `[auth] detected likely login window "${title}" — attempting GUI login`);

        if (isAnvil && (cfg.mode === 'anvil' || cfg.mode === 'both')) {
            await runAnvilLogin(bot, cfg);
        } else if (cfg.mode === 'gui' || cfg.mode === 'both') {
            await runGuiLogin(bot, cfg);
        }
    });
}