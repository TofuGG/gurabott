/**
 * auth.ts - AuthMe-style server login
 *
 * Handles four login styles, selectable via config.auth.mode:
 *   - "command": sends `/login <password>` (and `/register` as a fallback)
 *                as a normal chat message. Works for the vast majority of
 *                AuthMe/AuthMeReloaded setups, even ones that also show a GUI.
 *   - "anvil":   for servers whose "GUI" is really an anvil-rename screen —
 *                the bot "types" the password by renaming the anvil's input
 *                item, then clicks the output slot to submit.
 *   - "gui":     for custom chest/inventory keypads. Clicks a sequence of
 *                slots (one per password character, from config.auth.gui.slotMap)
 *                followed by an optional "confirm" slot.
 *   - "dialog":  for 1.21.6+ AuthMeReloaded servers using the new dialog
 *                system (authmereload). The server holds the client in the
 *                CONFIGURATION phase and sends a `show_dialog` login screen;
 *                the bot acks the config-phase resource pack (3→4→0) to
 *                unlock it, then submits the password via `custom_click_action`.
 *   - "both":    runs the command AND whichever GUI strategy applies.
 *
 * Every server's custom login GUI is different, so config.auth.debugWindows
 * lets you first log the title/type/slots of whatever window opens, so you
 * can fill in config.auth.gui.slotMap yourself before enabling "gui"/"anvil".
 */

import type { Bot } from 'mineflayer';
import { addLog } from '../core/store.ts';
import { sleep, flattenChatComponent } from '../utils.ts';

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
    mode: 'command' | 'gui' | 'anvil' | 'dialog' | 'both';
    debugWindows: boolean;
    gui: GuiAuthConfig;
}

// Window titles can be a plain string, a JSON chat component, or a raw
// prismarine-nbt node — flatten any of them to readable text.
function titleToPlainText(title: unknown): string {
    if (typeof title !== 'string') return flattenChatComponent(title as any);
    try {
        const parsed = JSON.parse(title);
        if (parsed && typeof parsed === 'object') return flattenChatComponent(parsed);
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
        const custom = item.customName ? ` custom="${flattenChatComponent(item.customName)}"` : '';
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

// ── Dialog (1.21.6+ AuthMeReloaded) ──────────────────────────────────────────
// The server holds the client in the CONFIGURATION phase. It sends an
// add_resource_pack first; only after the client acks it (accepted →
// downloaded → loaded) does the server send the show_dialog login screen.
// We then submit the password by clicking the dialog's "Login" action.

type NbtValue = { type: string; value?: any };

function nbtString(v: NbtValue | undefined, key: string): string | undefined {
    const inner = v?.value;
    if (inner && typeof inner === 'object' && typeof inner[key] === 'object') {
        return inner[key]?.value;
    }
    return undefined;
}

// Finds the dialog action that performs the actual login (skips cancel/logout
// buttons), returning its action id. Falls back to the first action if none
// obviously matches, and null if there are no actions at all.
function findLoginActionId(dialog: any): string | null {
    const actions = dialog?.value?.actions?.value?.value;
    if (!Array.isArray(actions) || actions.length === 0) return null;
    const preferred = actions.find((a: any) => {
        const id = nbtString(a?.action, 'id') ?? '';
        return id.includes('login') && !id.includes('cancel') && !id.includes('logout');
    });
    const chosen = preferred ?? actions[0];
    return nbtString(chosen?.action, 'id') ?? null;
}

// Finds the dialog text input's key (the password field). Falls back to the
// first input, and to a hardcoded "password" key if the dialog has no inputs.
function findPasswordInputKey(dialog: any): string {
    const inputs = dialog?.value?.inputs?.value?.value;
    if (!Array.isArray(inputs) || inputs.length === 0) return 'password';
    const preferred = inputs.find((i: any) => (nbtString(i, 'key') ?? '').toLowerCase().includes('password'));
    const chosen = preferred ?? inputs[0];
    return nbtString(chosen, 'key') ?? 'password';
}

async function runDialogLogin(bot: Bot, password: string): Promise<void> {
    const client = (bot as any)._client;
    if (!client) return;

    // Ack any config-phase resource pack so the server unlocks the dialog.
    // Must be 3 (accepted) → 4 (downloaded) → 0 (loaded) — a plain
    // "accepted" alone does not progress, as verified live against the server.
    const onResourcePack = (data: any) => {
        addLog('system', '[auth] dialog: acking resource pack (3→4→0)');
        try {
            client.write('resource_pack_receive', { uuid: data.uuid, result: 3 });
            setTimeout(() => client.write('resource_pack_receive', { uuid: data.uuid, result: 4 }), 150);
            setTimeout(() => client.write('resource_pack_receive', { uuid: data.uuid, result: 0 }), 300);
        } catch (err: any) {
            addLog('error', `[auth] dialog: resource pack ack failed: ${err?.message ?? err}`);
        }
    };

    // When the login screen appears, click its Login action with the password.
    const onShowDialog = (data: any) => {
        const actionId = findLoginActionId(data.dialog);
        const inputKey = findPasswordInputKey(data.dialog);
        addLog('system', `[auth] dialog: got login screen — clicking "${actionId}" with input "${inputKey}"`);
        if (!actionId) {
            addLog('error', '[auth] dialog: no actions in login screen — cannot submit');
            return;
        }
        try {
            client.write('custom_click_action', {
                id: actionId,
                payload: { type: 'compound', value: { [inputKey]: { type: 'string', value: password } } },
            });
            addLog('system', '[auth] dialog: submitted password');
        } catch (err: any) {
            addLog('error', `[auth] dialog: submit failed: ${err?.message ?? err}`);
        }
    };

    client.on('add_resource_pack', onResourcePack);
    client.on('show_dialog', onShowDialog);

    // Clean up the listeners when the connection ends so a reconnected bot
    // doesn't keep firing these against the dead client.
    client.once('end', () => {
        client.removeListener('add_resource_pack', onResourcePack);
        client.removeListener('show_dialog', onShowDialog);
    });
}

export function initAuth(bot: Bot, cfg: AuthConfig): void {
    if (!cfg.enabled) {
        addLog('system', '[AUTH] Auth disabled — skipping');
        return;
    }
    addLog('system', `[AUTH] Auth enabled — mode: ${cfg.mode}`);

    if (cfg.mode === 'dialog') {
        // Dialog logins happen during the CONFIGURATION phase, before
        // 'login' ever fires — the whole point is that the server won't
        // finish configuration (and thus never send join_game) until the
        // password is submitted. Set it up immediately on the raw client.
        addLog('system', '[AUTH] Dialog login enabled — awaiting config-phase login screen');
        void runDialogLogin(bot, cfg.password);
        return;
    }

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
            // Flag the moment the connection dies so a stale 1s timer can't
            // send /login against a dead bot (or a different, reconnected bot).
            let ended = false;
            bot.once('end', () => { ended = true; });
            setTimeout(() => {
                if (ended) return;
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