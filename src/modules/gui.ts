/**
 * gui.ts - Generic interactive chest-GUI controller (/shop, /sell, spawner menus)
 *
 * Some servers (EssentialsShop, ChestShop, ShopGUI+, DeluxeMenus, spawner
 * plugins...) expose trading through chest/inventory GUIs instead of chat
 * commands. A GUI is a "window": an array of slots the bot can read and click
 * exactly like a real client. Layouts differ wildly per server, so this module
 * follows the auth.ts pattern:
 *
 *   1. Turn on window-slot scanning (gscan / config.gui.debugWindows) and open
 *      the GUI — every window that opens is dumped to the log (title, type,
 *      and each slot's name/displayName/customName/lore) so you can map it.
 *   2. Fill in config.gui.profiles with the layout you discovered: how the GUI
 *      opens, which title identifies it, and the click sequences to perform.
 *   3. Drive it from gopen / grun / gsell / gspawner / gsdrop.
 *
 * A profile is:
 *   - `open`:       how the window gets opened — a chat command (e.g. "/sell")
 *                   or walking to and right-clicking a block (e.g. a spawner).
 *   - `titleMatch`: title substrings that identify this window, so unrelated
 *                   GUIs (chests, the AuthMe login) are ignored.
 *   - `actions`:    named click sequences. Steps either click an absolute
 *                   slot, click the first slot whose item matches a
 *                   name/customName/lore (robust to pagination and layout
 *                   shifts), wait, or close. `shift: true` makes a step a
 *                   shift-click (moves whole stacks, e.g. pushing inventory
 *                   items into a sell area).
 */

import type { Bot } from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { Vec3 } from 'vec3';
import { addLog } from '../core/store.ts';
import { sleep, safeGoto, withTimeout, flattenChatComponent } from '../utils.ts';
import { startStare, stopStare, isStaring, suppressMovement, resumeMovement } from '../movementAI.ts';
import { BotState, getState } from './state.ts';
import type { BotSession } from '../session.ts';

const baritoneGoals = baritonePlugin.goals;

// ── Config types ──────────────────────────────────────────────────────────────

export interface GuiClickStep {
    /** Absolute window-slot index to click. Ignored when clickItem is set. */
    slot?: number;
    /** Click the first slot whose item matches any of these substrings. */
    clickItem?: { name?: string; customName?: string; lore?: string };
    /** Shift-click (mode 1): moves whole stacks (inventory ⇄ sell area). */
    shift?: boolean;
    /** Raw window-click overrides (defaults: mouseButton 0, mode shift?1:0). */
    mouseButton?: number;
    mode?: number;
    /** Extra pause after this click (ms); the profile clickDelayMs is also applied. */
    wait?: number;
}

export type GuiStep =
    | { wait: number }
    | { close: true }
    | GuiClickStep;

export interface GuiActionConfig {
    steps: GuiStep[];
}

export interface GuiOpenConfig {
    via: 'chat' | 'rightClickBlock';
    /** Chat command to type (via: "chat"), e.g. "/sell". */
    command?: string;
    /** Block name to find/walk to/right-click (via: "rightClickBlock"). */
    block?: string;
    /** How long to wait for the window to open after triggering it (ms). */
    waitForOpenMs?: number;
}

export interface GuiProfileConfig {
    /** Title substrings (case-insensitive) that identify this window. */
    titleMatch: string[];
    /** How the window gets opened. */
    open: GuiOpenConfig;
    /** Named click sequences, e.g. { sell: { steps: [...] } }. */
    actions: Record<string, GuiActionConfig>;
    /** Pause between clicks in this window (ms). Defaults to 400. */
    clickDelayMs?: number;
}

export interface GuiConfig {
    debugWindows: boolean;
    profiles: Record<string, GuiProfileConfig>;
    /** Run the 30-minute auto gsdrop (spawner → chest → drop all) until the
     *  spawner is empty. Defaults to on when unset. */
    autoGsdrop?: boolean;
    /** Run the 30-minute auto gsell (shop profile "sell" action). Defaults to
     *  on when unset. */
    autoSell?: boolean;
    /** Recorded route (waypoint JSON) walked before opening the shop during an
     *  auto-sell, so the bot reaches a reach-anchored sell spot. */
    sellPath?: string | null;
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** Some servers send the window title as a JSON chat component, not a string;
 *  on 1.20.5+ item custom names/lores are chat-component objects too. Flatten
 *  any of these (string / JSON-string / component object / array) to text. */
export function titleToPlainText(title: unknown): string {
    if (typeof title === 'string') {
        try {
            const parsed = JSON.parse(title);
            if (parsed && typeof parsed === 'object') return flattenChatComponent(parsed);
        } catch {
            // Not JSON — already plain text.
        }
        return title;
    }
    return flattenChatComponent(title as any);
}

export function windowMatchesTitle(title: unknown, titleMatch: string[]): boolean {
    const t = titleToPlainText(title).toLowerCase();
    return titleMatch.some((m) => t.includes(m.toLowerCase()));
}

const norm = (s: unknown): string => flattenChatComponent(s as any).toLowerCase();

/** True when an item satisfies every supplied substring criterion. Item names,
 *  display names, custom names and lore are chat components on 1.20.5+, so all
 *  are flattened before matching. */
export function itemMatches(
    item: any,
    criteria: { name?: string; customName?: string; lore?: string },
): boolean {
    if (!item) return false;
    const { name, customName, lore } = criteria;
    if (name && !norm(item.name).includes(norm(name)) && !norm(item.displayName).includes(norm(name))) return false;
    if (customName && !norm(item.customName).includes(norm(customName))) return false;
    if (lore) {
        const loreText = Array.isArray(item.customLore)
            ? item.customLore.map((l: any) => flattenChatComponent(l)).join(' ')
            : flattenChatComponent(item.customLore as any);
        if (!norm(loreText).includes(norm(lore))) return false;
    }
    return true;
}

/** First window-slot index whose item matches, or null. */
export function findSlotByItem(
    window: any,
    criteria: { name?: string; customName?: string; lore?: string },
): number | null {
    const slots = window?.slots;
    if (!Array.isArray(slots)) return null;
    for (let i = 0; i < slots.length; i++) {
        if (itemMatches(slots[i], criteria)) return i;
    }
    return null;
}

/** First container-region slot whose item's name/displayName/customName
 *  contains `wanted` (case-insensitive, components flattened), or null. Stops
 *  at the player inventory so the bot's own items can never match a button. */
function findSlotByItemName(window: any, wanted: string): number | null {
    const slots = window?.slots;
    if (!Array.isArray(slots)) return null;
    const invStart = (window.inventoryStart ?? slots.length) as number;
    for (let i = 0; i < Math.min(invStart, slots.length); i++) {
        const item = slots[i];
        if (!item) continue;
        if (
            norm(item.name).includes(wanted) ||
            norm(item.displayName).includes(wanted) ||
            norm(item.customName).includes(wanted)
        ) return i;
    }
    return null;
}

// ── Controller state ──────────────────────────────────────────────────────────

let bot: Bot | null = null;
let cfg: GuiConfig | null = null;
let session: BotSession | null = null;
let scanMode = false;
let busy = false;
let configureBaritone: (overrides?: Record<string, any>) => void = () => {};

// Auto-drop state: `lastDropStoredCount` is how many stored drops the most
// recent dropFromSpawner() round found in the submenu (0 = spawner empty), and
// `autoDropRunning` prevents two scheduled runs from overlapping.
let lastDropStoredCount = 0;
let autoDropRunning = false;

// Auto-sell state: `autoSellRunning` prevents two scheduled runs from
// overlapping (auto gsdrop and auto sell share the `busy` flag).
let autoSellRunning = false;

// 1.17+ servers gate every container click on a per-window `stateId`; a click
// carrying a stale stateId is silently dropped. mineflayer keeps ONE global
// stateId that any window's window_items/set_slot overwrites, so track it per
// window here and send vanilla-style raw clicks when we need a guaranteed hit.
const stateIdByWindow = new Map<number, number>();

// ── Window helpers ────────────────────────────────────────────────────────────

/** Compact structural dump of a component (chat or raw NBT) so undecodable
 *  names/lores reveal their real shape instead of "[object Object]". */
function describeComponent(v: any, depth = 0): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v.length > 28 ? v.slice(0, 28) + '…' : v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
        if (depth > 4) return 'arr…';
        return '[' + v.map((x) => describeComponent(x, depth + 1)).join(',') + ']';
    }
    if (typeof v === 'object') {
        if (depth > 4) return 'obj…';
        return '{' + Object.keys(v).map((k) => `${k}=${describeComponent(v[k], depth + 1)}`).join(' ') + '}';
    }
    return String(v);
}

/** Flatten a component for display; if it still won't decode, append the raw
 *  structure so the next scan can pin down the shape. */
function flattenOrDump(v: any): string {
    const flat = flattenChatComponent(v);
    if (flat.includes('[object Object]')) return `${flat} ⇐ ${describeComponent(v)}`;
    return flat;
}

function logWindowSlots(window: any): void {
    const title = titleToPlainText(window.title);
    addLog('system', `[GUI] window opened — id=${window.id} type=${window.type} title="${title}"`);
    window.slots.forEach((item: any, index: number) => {
        if (!item) return;
        const customName = item.customName ? ` customName="${flattenOrDump(item.customName)}"` : '';
        const loreItems = Array.isArray(item.customLore) ? item.customLore : item.customLore ? [item.customLore] : [];
        const lore = loreItems.length
            ? ` lore="${loreItems.map((l: any) => flattenOrDump(l)).join(' | ')}"`
            : '';
        addLog('system', `[GUI]   slot ${index}: ${item.name} (${item.displayName}) x${item.count}${customName}${lore}`);
    });
}

/** Resolve as soon as a matching window is open; null on timeout. */
async function waitForWindow(titleMatch: string[], timeoutMs: number): Promise<any | null> {
    const b = bot;
    if (!b) return null;
    if (b.currentWindow && windowMatchesTitle(b.currentWindow.title, titleMatch)) {
        return b.currentWindow;
    }
    return new Promise<any | null>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            b.removeListener('windowOpen', onOpen);
        };
        const onOpen = (window: any) => {
            if (windowMatchesTitle(window.title, titleMatch)) {
                cleanup();
                resolve(window);
            }
        };
        timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
        b.on('windowOpen', onOpen);
    });
}

/** Resolve as soon as ANY window is open; null on timeout. Used for discovery
 *  scans (gspawner) where the window's title isn't known yet. */
async function waitForAnyWindow(timeoutMs: number): Promise<any | null> {
    const b = bot;
    if (!b) return null;
    if (b.currentWindow) return b.currentWindow;
    return new Promise<any | null>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            b.removeListener('windowOpen', onOpen);
        };
        const onOpen = (window: any) => {
            cleanup();
            resolve(window);
        };
        timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
        b.on('windowOpen', onOpen);
    });
}

function currentMatchingWindow(titleMatch: string[]): any | null {
    const w = bot?.currentWindow;
    return w && windowMatchesTitle(w.title, titleMatch) ? w : null;
}

// ── Opening a profile's GUI ───────────────────────────────────────────────────

// The spawner block was renamed mob_spawner → spawner in Minecraft 1.21, so a
// config/command that names either must match both — one profile works on any
// version (the bot runs on 1.21.11, where the block is just "spawner").
export function blockNameCandidates(name: string): string[] {
    if (name === 'spawner' || name === 'mob_spawner') return ['spawner', 'mob_spawner'];
    return [name];
}

function findBlockNamed(name: string, maxDistance: number): any | null {
    const b = bot;
    if (!b) return null;
    const candidates = blockNameCandidates(name);
    return b.findBlock({ matching: (blk: any) => candidates.includes(blk?.name), maxDistance });
}

async function openGui(profile: GuiProfileConfig): Promise<boolean> {
    const b = bot;
    if (!b || !b.entity) return false;
    const open = profile.open;
    const waitMs = open.waitForOpenMs ?? 8000;

    if (open.via === 'chat') {
        if (!open.command) {
            addLog('error', '[GUI] profile.open.via "chat" needs open.command');
            return false;
        }
        addLog('system', `[GUI] sending "${open.command}" to open the window`);
        try { b.chat(open.command); } catch (err: any) {
            addLog('error', `[GUI] chat open failed: ${err?.message ?? err}`);
            return false;
        }
        return (await waitForWindow(profile.titleMatch, waitMs)) !== null;
    }

    if (open.via === 'rightClickBlock') {
        const blockName = open.block ?? 'spawner';
        const block = findBlockNamed(blockName, 32);
        if (!block) {
            addLog('error', `[GUI] no ${blockName} within 32 blocks`);
            return false;
        }
        addLog('system', `[GUI] walking to ${blockName} at ${block.position.floored()}`);
        configureBaritone();
        const nav = await safeGoto(
            b,
            new baritoneGoals.GoalNear(new Vec3(block.position.x, block.position.y, block.position.z), 2),
            15000,
        );
        if (nav.status !== 'success') {
            addLog('error', `[GUI] could not reach ${blockName}: ${nav.error?.message ?? nav.status}`);
            return false;
        }
        const freshBlock = b.blockAt(block.position);
        if (!freshBlock) return false;
        addLog('system', '[GUI] right-clicking the block to open its window');
        try {
            await withTimeout(b.activateBlock(freshBlock), 10000);
        } catch (err: any) {
            addLog('error', `[GUI] activate failed: ${err?.message ?? err}`);
            return false;
        }
        return (await waitForWindow(profile.titleMatch, waitMs)) !== null;
    }

    addLog('error', `[GUI] unknown open strategy "${open.via}"`);
    return false;
}

// ── Click sequences ───────────────────────────────────────────────────────────

async function runSteps(window: any, steps: GuiStep[], clickDelayMs: number): Promise<boolean> {
    const b = bot;
    if (!b) return false;

    for (const step of steps) {
        if (b.currentWindow !== window) {
            addLog('error', '[GUI] window closed mid-sequence — aborting');
            return false;
        }

        // Close
        if ('close' in step && step.close) {
            addLog('system', '[GUI] closing window');
            try { b.closeWindow(window); } catch {}
            await sleep(clickDelayMs);
            continue;
        }

        // Pure wait
        if ('wait' in step && !('slot' in step) && !('clickItem' in step)) {
            await sleep((step as { wait: number }).wait);
            continue;
        }

        const click = step as GuiClickStep;
        let slot = click.slot;

        if (click.clickItem) {
            slot = findSlotByItem(window, click.clickItem) ?? undefined;
            if (slot === undefined) {
                addLog('error', `[GUI] no slot matches ${JSON.stringify(click.clickItem)} — run gscan to see the layout`);
                return false;
            }
        }

        if (slot === undefined) {
            addLog('error', '[GUI] step needs either slot or clickItem');
            return false;
        }

        const mouseButton = click.mouseButton ?? 0;
        const mode = click.mode ?? (click.shift ? 1 : 0);
        addLog('system', `[GUI] click slot ${slot} (button=${mouseButton} mode=${mode}${click.shift ? ', shift' : ''})`);
        try {
            await withTimeout(b.clickWindow(slot, mouseButton, mode), 8000);
        } catch (err: any) {
            addLog('error', `[GUI] click slot ${slot} failed: ${err?.message ?? err}`);
            return false;
        }
        await sleep(click.wait ?? clickDelayMs);
    }

    return true;
}

async function runAction(profile: GuiProfileConfig, action: GuiActionConfig, alreadyOpen: boolean): Promise<boolean> {
    const window = alreadyOpen ? currentMatchingWindow(profile.titleMatch) : null;
    const target = window ?? await waitForWindow(profile.titleMatch, profile.open.waitForOpenMs ?? 8000);
    if (!target) {
        addLog('error', '[GUI] expected window never opened — run gscan to see what actually opened');
        return false;
    }
    if (scanMode) logWindowSlots(target);
    return runSteps(target, action.steps, profile.clickDelayMs ?? 400);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Attach the controller to a connection. Registers scan listeners; cleaned up on disconnect. */
export function initGui(
    b: Bot,
    config: GuiConfig,
    sess: BotSession,
    configure: (overrides?: Record<string, any>) => void,
): void {
    bot = b;
    cfg = config;
    session = sess;
    configureBaritone = configure;
    scanMode = config.debugWindows;

    b.on('windowOpen', (window: any) => {
        if (scanMode) logWindowSlots(window);
    });

    // Track the latest stateId per window (see stateIdByWindow above).
    const trackState = (packet: any) => {
        if (packet && typeof packet.stateId === 'number') stateIdByWindow.set(packet.windowId, packet.stateId);
    };
    b._client.on('window_items', trackState);
    b._client.on('set_slot', trackState);

    sess.onEnd(() => {
        bot = null;
        cfg = null;
        session = null;
        busy = false;
        stateIdByWindow.clear();
        lastDropStoredCount = 0;
        autoDropRunning = false;
    });
}

export function setScanMode(enabled: boolean): void {
    scanMode = enabled;
}

export function isScanMode(): boolean {
    return scanMode;
}

export function getProfileNames(): string[] {
    return cfg ? Object.keys(cfg.profiles) : [];
}

/** Dump the currently-open window if any (used by gscan on). */
export function dumpCurrentWindow(): void {
    const w = bot?.currentWindow;
    if (w) logWindowSlots(w);
    else addLog('system', '[GUI] no window currently open');
}

/**
 * Find the nearest `blockName`, walk to it if it's outside interaction reach,
 * right-click it, and wait for any window to open. Returns the window and the
 * block's position (or null on failure). Shared by gspawner (scan) and gsdrop.
 */
async function openBlockWindow(blockName: string, waitMs: number, approachWithin = 5): Promise<{ window: any; blockPos: Vec3 } | null> {
    const b = bot;
    if (!b || !b.entity) return null;

    // findBlock is a full volume scan of LOADED chunks within a radius — water
    // or walls never block it, but the block must be inside the radius AND the
    // client must have the chunk loaded. 96 blocks ≈ a 6-chunk radius, well
    // within the default render distance; beyond that the chunk simply isn't
    // loaded and nothing can find the block without moving closer.
    const SEARCH_RADIUS = 96;
    const block = findBlockNamed(blockName, SEARCH_RADIUS);
    if (!block) {
        const pos = b.entity.position;
        addLog('error', `[GUI] no ${blockName} within ${SEARCH_RADIUS} blocks of ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} — use gotocord to get closer (chunks beyond render distance can't be scanned)`);
        return null;
    }

    // If the block is already within interaction reach (the bot was placed
    // right in front of it), skip pathfinding entirely — baritone frequently
    // can't find a route to a spawner on a custom server even when it's only
    // a few blocks away, and the user's flow is to position the bot by hand.
    const dist = block.position.distanceTo(b.entity.position);
    if (dist > approachWithin) {
        addLog('system', `[GUI] walking to ${blockName} at ${block.position.floored()} (${Math.round(dist)} blocks away)`);
        configureBaritone();
        const nav = await safeGoto(
            b,
            new baritoneGoals.GoalNear(new Vec3(block.position.x, block.position.y, block.position.z), 1),
            20000,
        );
        if (nav.status !== 'success') {
            const still = block.position.distanceTo(b.entity.position);
            if (still <= 6) {
                addLog('warn', `[GUI] could not get closer to ${blockName} (${nav.status}) — still ${Math.round(still)} blocks away, right-clicking from here`);
            } else {
                addLog('error', `[GUI] could not reach ${blockName}: ${nav.error?.message ?? nav.status}`);
                return null;
            }
        }
    } else {
        addLog('system', `[GUI] ${blockName} at ${block.position.floored()} is ${Math.round(dist)} block(s) away — right-clicking directly`);
    }
    const freshBlock = b.blockAt(block.position);
    if (!freshBlock) return null;

    // Subscribe BEFORE right-clicking: right-clicking a spawner opens a
    // chest-style window whose items act as buttons, and some servers emit
    // the windowOpen packet synchronously during activateBlock. Waiting
    // afterwards would miss it and time out scanning nothing.
    const windowPromise = waitForAnyWindow(waitMs);
    addLog('system', '[GUI] right-clicking the block to open its window');
    let activateError: any = null;
    try {
        await withTimeout(b.activateBlock(freshBlock), 10000);
    } catch (err: any) {
        activateError = err;
        addLog('error', `[GUI] activate failed: ${err?.message ?? err}`);
    }
    const window = await windowPromise;
    if (!window) {
        addLog('error', `[GUI] no window opened after right-clicking the block${activateError ? ' (activate threw)' : ''} — nothing to scan`);
        return null;
    }
    if (activateError) addLog('warn', '[GUI] window opened despite the activate error — scanning it');
    return { window, blockPos: block.position };
}

/**
 * Walk to the nearest block of `blockName`, right-click it, wait for a window
 * to open, and dump every slot to the TUI log. Discovery step for spawner GUIs
 * (gspawner) — run it before configuring any click sequence so you can map the
 * layout. Returns true if a window opened and was dumped.
 */
export async function openAndScanBlock(blockName = 'spawner', waitMs = 8000): Promise<boolean> {
    if (busy) { addLog('warn', '[GUI] busy — wait for the current GUI task to finish'); return false; }
    busy = true;
    try {
        const { window } = await openBlockWindow(blockName, waitMs) ?? {};
        if (!window) return false;
        logWindowSlots(window);
        return true;
    } finally {
        busy = false;
    }
}

/**
 * Wait until the current window contains an item whose name/displayName
 * contains `wanted`, polling every 150ms up to `timeoutMs`. Returns the
 * container-region slot index or null. Polling (instead of listening for
 * windowOpen) covers both in-place slot updates and servers that swap in a new
 * window — mineflayer keeps `currentWindow` pointing at whatever is open.
 */
async function waitForSlotItem(wanted: string, timeoutMs: number): Promise<number | null> {
    const b = bot;
    if (!b) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const slot = b.currentWindow ? findSlotByItemName(b.currentWindow, wanted) : null;
        if (slot !== null) return slot;
        await sleep(150);
    }
    return null;
}

// GUI buttons (root spawner GUI + the drop submenu) — everything else in the
// container region is a stored drop item, the thing "drop all" should remove.
const BUTTON_NAMES = new Set([
    'chest', 'skeleton_skull', 'experience_bottle',
    'cauldron', 'hopper', 'gold_ingot', 'bundle', 'dropper',
]);

/** Container-region slots (slot → item name) holding stored drops, excluding
 *  the GUI's own buttons. Empty slots and the player inventory are skipped. */
function storedDropSlots(window: any): Map<number, string> {
    const m = new Map<number, string>();
    const slots = window?.slots;
    if (!Array.isArray(slots)) return m;
    const invStart = (window.inventoryStart ?? slots.length) as number;
    for (let i = 0; i < Math.min(invStart, slots.length); i++) {
        const item = slots[i];
        if (item && !BUTTON_NAMES.has(item.name)) m.set(i, item.name);
    }
    return m;
}

/** Verify the drop happened: every snapshot slot must empty out (same window
 *  id — the submenu stays open on this server), or the server closes the
 *  window itself. Returns true on either, false if the items are still there
 *  when the timeout expires. */
async function verifyDropCleared(submenu: any, snapshot: Map<number, string>, timeoutMs: number): Promise<boolean> {
    const b = bot;
    if (!b) return true;
    if (snapshot.size === 0) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const w = b.currentWindow;
        if (!w) return true; // server closed the window — drop executed
        if (w.id === submenu.id) {
            const slots = w.slots;
            let allGone = true;
            for (const slotIdx of snapshot.keys()) {
                if (slots[slotIdx]) { allGone = false; break; }
            }
            if (allGone) return true;
        }
        await sleep(150);
    }
    return false;
}

/** Ids of dropped-item entities within `radius` of `pos` (ground truth for a
 *  drop that the server never reflects back into the GUI window). */
function itemDropIdsNear(pos: Vec3 | null, radius: number): Set<number> {
    const b = bot;
    const ids = new Set<number>();
    if (!b || !pos) return ids;
    for (const [id, ent] of Object.entries(b.entities)) {
        const name = (ent as any)?.name?.toLowerCase?.() ?? '';
        if (name !== 'item' && name !== 'item_stack') continue;
        if ((ent as any).position?.distanceTo(pos) <= radius) ids.add(Number(id));
    }
    return ids;
}

/**
 * Send a button click the way a real client does, bypassing mineflayer's
 * global (and possibly stale) stateId and its non-clean cursor encoding. This
 * is the reliable path for plugin-GUI action buttons (the spawner's drop-all
 * on 1.21, where the transaction packet no longer exists and a stale stateId
 * makes the server silently drop the click). Falls back to mineflayer's
 * clickWindow if the raw write isn't available.
 */
async function clickSlotClean(window: any, slot: number, opts: { mouseButton?: number; mode?: number } = {}): Promise<boolean> {
    const b = bot;
    if (!b || !window) return false;
    const mouseButton = opts.mouseButton ?? 0;
    const mode = opts.mode ?? 0;
    const stateId = stateIdByWindow.get(window.id) ?? -1;
    addLog('system', `[GUI] click slot ${slot} (button=${mouseButton} mode=${mode} windowId=${window.id} stateId=${stateId})`);
    try {
        const client = b._client as any;
        if (typeof client?.write !== 'function') {
            await withTimeout(b.clickWindow(slot, mouseButton, mode), 8000);
            return true;
        }
        client.write('window_click', {
            windowId: window.id,
            stateId,
            slot,
            mouseButton,
            mode,
            changedSlots: [],
            cursorItem: null,
        });
        return true;
    } catch (err: any) {
        addLog('error', `[GUI] click slot ${slot} failed: ${err?.message ?? err}`);
        return false;
    }
}

/**
 * Manually drop from the spawner GUI (gsdrop), keeping the bot positioned at
 * the spawner the whole time:
 *
 *   1. Right-click the nearest spawner to open its GUI.
 *   2. Click the chest button (opens the drop submenu).
 *   3. Click the dropper ("drop all") button.
 *   4. Verify the stored drops (bones) actually left the GUI — if they're
 *      still there after the click, the drop is reported as failed.
 *
 * Steps are matched by item name rather than hardcoded slots so the command
 * survives layout shifts. Returns true only when the drop is confirmed.
 */
export async function dropFromSpawner(): Promise<boolean> {
    if (busy) { addLog('warn', '[GUI] busy — wait for the current GUI task to finish'); return false; }
    const b = bot;
    if (!b) return false;

    busy = true;
    let startedStare = false;
    try {
        // 1. Get the spawner root GUI. If a window is already open, only reuse
        // it when it's actually the root spawner GUI (it has the chest button);
        // anything else is a stale leftover (e.g. the drop submenu from the
        // previous run, whose chest button is gone) — close it and reopen.
        let window = b.currentWindow;
        let spawnerPos: Vec3 | null = null;
        if (window && findSlotByItemName(window, 'chest') === null) {
            addLog('system', '[GUI] open window has no chest button — stale, closing and reopening');
            try { b.closeWindow(window); } catch {}
            window = null;
        }
        if (!window) {
            addLog('system', '[GUI] opening the spawner GUI');
            const opened = await openBlockWindow('spawner', 8000, 2.5);
            if (!opened) return false;
            window = opened.window;
            spawnerPos = opened.blockPos;
        } else {
            // Window reused from a previous run — re-resolve the spawner block
            // so the stare keeps the bot facing it (not the players) through
            // the drop and the 5s pause after it.
            spawnerPos = findBlockNamed('spawner', 32)?.position ?? null;
        }

        // Lock the head on the spawner for the whole interaction + 5s after the
        // drop. This freezes player-glance/greet/wander behaviors in
        // movementAI (stareTarget gate) so dropped bones land toward the
        // water instead of toward whoever walked up to the bot. If the user is
        // already in a manual glook stare, leave their stare alone.
        startedStare = spawnerPos !== null && !isStaring();
        if (startedStare) startStare(b, spawnerPos!, session!);

        // 2. Click the chest button to reach the drop submenu.
        const chestSlot = findSlotByItemName(window, 'chest');
        if (chestSlot === null) {
            addLog('error', '[GUI] no chest button in the spawner GUI — run gspawner to see the layout');
            return false;
        }
        addLog('system', `[GUI] clicking the chest button (slot ${chestSlot})`);
        try {
            await withTimeout(b.clickWindow(chestSlot, 0, 0), 8000);
        } catch (err: any) {
            addLog('error', `[GUI] chest click failed: ${err?.message ?? err}`);
            return false;
        }

        // 3. Wait for the dropper ("drop all") button. Snapshot the stored
        // drops (the bones) in the submenu BEFORE clicking, so we can verify
        // afterwards that "drop all" actually emptied them.
        const dropSlot = await waitForSlotItem('dropper', 6000);
        if (dropSlot === null) {
            addLog('error', '[GUI] no dropper ("drop all") button appeared after clicking the chest');
            if (b.currentWindow) logWindowSlots(b.currentWindow);
            return false;
        }
        const submenu = b.currentWindow;
        const drops = storedDropSlots(submenu);
        lastDropStoredCount = drops.size;
        if (drops.size === 0) {
            addLog('system', '[GUI] no stored drops in the submenu — nothing to verify');
        } else {
            addLog('system', `[GUI] stored drops before the drop: ${[...drops.entries()].map(([s, n]) => `slot ${s} (${n})`).join(', ')}`);
        }
        const itemDropsBefore = itemDropIdsNear(spawnerPos, 8);

        // 4. Try the plausible click interactions until one empties the stored
        // drops (or item entities appear near the spawner). Plugins bind "drop
        // all" to different clicks — plain / shift / right / double — and some
        // servers reject vanilla left-clicks outright, so verify each attempt
        // against the GUI instead of assuming a click type.
        const attempts = [
            { label: 'left-click', mouseButton: 0, mode: 0 },
            { label: 'shift-click', mouseButton: 0, mode: 1 },
            { label: 'right-click', mouseButton: 1, mode: 0 },
            { label: 'double-click', mouseButton: 0, mode: 6 },
        ];
        let dropped = false;
        let groundTruth = false;
        let workedLabel = '';
        for (const attempt of attempts) {
            addLog('system', `[GUI] attempting ${attempt.label} on the dropper / "drop all" (slot ${dropSlot})`);
            const clicked = await clickSlotClean(submenu, dropSlot, { mouseButton: attempt.mouseButton, mode: attempt.mode });
            if (!clicked) return false;
            dropped = await verifyDropCleared(submenu, drops, 2000);
            if (dropped) { workedLabel = attempt.label; break; }
            const nowDrops = itemDropIdsNear(spawnerPos, 8);
            const newDrops = [...nowDrops].filter((id) => !itemDropsBefore.has(id)).length;
            if (newDrops > 0) {
                groundTruth = true;
                workedLabel = attempt.label;
                addLog('system', `[GUI] GUI bones unchanged but ${newDrops} new item drop(s) appeared near the spawner — drop executed`);
                break;
            }
        }
        if (!dropped && !groundTruth) {
            addLog('error', '[GUI] drop FAILED — none of left/shift/right/double-click emptied the stored drops');
            if (b.currentWindow) {
                addLog('system', '[GUI] window contents after the failed drop:');
                logWindowSlots(b.currentWindow);
                try { b.closeWindow(b.currentWindow); } catch {}
            }
            return false;
        }
        addLog('system', drops.size === 0
            ? '[GUI] no stored drops to verify — done'
            : groundTruth
                ? `[GUI] drop confirmed via ${workedLabel} (items appeared near the spawner)`
                : `[GUI] drop confirmed via ${workedLabel} — stored drops are gone from the GUI`);

        // 5. Close the window so the next gsdrop starts from a clean state.
        if (b.currentWindow) {
            try { b.closeWindow(b.currentWindow); } catch {}
        }
        return true;
    } finally {
        busy = false;
        // Keep staring at the spawner for 5s after the drop completes so the
        // bot doesn't rotate toward a passing player while the dropped items
        // are still landing (they should fall toward the water, not players).
        if (startedStare) {
            try { await sleep(5000); } catch {}
            stopStare(b);
        }
    }
}

// ── Auto gsdrop (30-minute cadence) ──────────────────────────────────────────

export const AUTO_DROP_INTERVAL_MS = 30 * 60 * 1000;
export const AUTO_DROP_FIRST_DELAY_MS = 20 * 1000;
export const AUTO_SELL_INTERVAL_MS = 30 * 60 * 1000;
export const AUTO_SELL_FIRST_DELAY_MS = 15 * 1000;

/**
 * Drain the spawner's drop chest until it's empty (the 30-minute auto task).
 *
 * The submenu can hold 2–3 pages of stored drops, so one drop cycle may not
 * clear everything: each `dropFromSpawner()` round re-opens the root GUI and
 * re-enters the chest submenu, and reports how many stored drops it found. A
 * round that finds zero means the spawner is drained; otherwise we run again,
 * capped at `maxRounds` so an unexpected pagination layout can't loop forever.
 *
 * Each round is logged with the `[auto]` tag so automated runs are
 * distinguishable from manual `[SHELL] gsdrop` invocations.
 */
export async function autoDropFromSpawner(maxRounds = 6): Promise<void> {
    if (autoDropRunning) { addLog('warn', '[auto] gsdrop already running — skipping'); return; }
    if (busy) { addLog('warn', '[auto] gsdrop skipped — GUI busy'); return; }
    const b = bot;
    if (!b?.entity || (b.health ?? 0) <= 0) {
        addLog('warn', '[auto] gsdrop skipped — bot not ready (dead/not connected)');
        return;
    }
    const state = getState();
    if (state !== BotState.IDLE && state !== BotState.FOLLOWING) {
        addLog('warn', `[auto] gsdrop skipped — state is ${state}, waiting for the next tick`);
        return;
    }

    autoDropRunning = true;
    try {
        for (let round = 1; round <= maxRounds; round++) {
            addLog('system', `[auto] gsdrop — round ${round}`);
            const ok = await dropFromSpawner();
            if (!ok) {
                addLog('warn', `[auto] gsdrop round ${round} failed — stopping`);
                return;
            }
            if (lastDropStoredCount === 0) {
                addLog('system', '[auto] spawner empty — auto drop complete');
                return;
            }
            addLog('system', `[auto] round ${round} dropped ${lastDropStoredCount} item(s) — more may remain, retrying`);
        }
        addLog('warn', `[auto] reached ${maxRounds} rounds without confirming empty — stopping (possible pagination issue)`);
    } finally {
        autoDropRunning = false;
    }
}

/**
 * Start the 30-minute auto-gsdrop scheduler: one run shortly after spawn, then
 * every AUTO_DROP_INTERVAL_MS. Timers are pushed into `intervals[]` so a
 * disconnect/end clears them with every other connection-owned interval.
 */
export function startAutoDropSpawner(opts: { intervals: NodeJS.Timeout[] }): void {
    const { intervals } = opts;

    const run = (): void => {
        if (cfg?.autoGsdrop === false) return;
        if (busy) { addLog('warn', '[auto] gsdrop skipped — GUI busy'); return; }
        addLog('system', '[auto] gsdrop — scheduled task fired');
        void autoDropFromSpawner();
    };

    intervals.push(setTimeout(run, AUTO_DROP_FIRST_DELAY_MS));
    intervals.push(setInterval(run, AUTO_DROP_INTERVAL_MS));
}

/**
 * Run the auto-sell: walk the recorded route to the shop (if
 * config.gui.sellPath is set), then open the shop profile and run its "sell"
 * action. Logged with the `[auto]` tag so automated runs are distinguishable
 * from manual `[SHELL] gsell` invocations. Returns true when the sell action
 * completed successfully.
 */
export async function autoSellFromShop(): Promise<boolean> {
    if (autoSellRunning) { addLog('warn', '[auto] gsell already running — skipping'); return false; }
    if (busy) { addLog('warn', '[auto] gsell skipped — GUI busy'); return false; }
    const b = bot;
    if (!b?.entity || (b.health ?? 0) <= 0) {
        addLog('warn', '[auto] gsell skipped — bot not ready (dead/not connected)');
        return false;
    }
    const state = getState();
    if (state !== BotState.IDLE && state !== BotState.FOLLOWING) {
        addLog('warn', `[auto] gsell skipped — state is ${state}, waiting for the next tick`);
        return false;
    }

    autoSellRunning = true;
    try {
        const pathFile = cfg?.sellPath;
        if (pathFile) {
            const { replayPath } = await import('./pathRecorder.ts');
            suppressMovement(b);
            let walked = false;
            try {
                walked = await replayPath(b, pathFile, { tag: 'auto' });
            } finally {
                resumeMovement();
            }
            if (!walked) {
                addLog('warn', '[auto] gsell skipped — could not walk the recorded route to the shop');
                return false;
            }
        }
        const ok = await runProfileAction('shop', 'sell');
        addLog('system', `[auto] gsell — ${ok ? 'items sold' : 'sell failed (see log)'}`);
        return ok;
    } finally {
        autoSellRunning = false;
    }
}

/**
 * Start the 30-minute auto-sell scheduler: one run shortly after spawn (offset
 * from the auto-gsdrop first delay so the two never fire on the same tick),
 * then every AUTO_SELL_INTERVAL_MS. Timers are pushed into `intervals[]` so a
 * disconnect/end clears them with every other connection-owned interval.
 */
export function startAutoSell(opts: { intervals: NodeJS.Timeout[] }): void {
    const { intervals } = opts;

    const run = (): void => {
        if (cfg?.autoSell === false) return;
        if (busy) { addLog('warn', '[auto] gsell skipped — GUI busy'); return; }
        addLog('system', '[auto] gsell — scheduled task fired');
        void autoSellFromShop();
    };

    intervals.push(setTimeout(run, AUTO_SELL_FIRST_DELAY_MS));
    intervals.push(setInterval(run, AUTO_SELL_INTERVAL_MS));
}

/**
 * Open a profile's GUI (chat command or right-click block) and wait for the
 * matching window. Returns true if the window is open and matches.
 */
export async function openProfile(name: string): Promise<boolean> {
    if (busy) { addLog('warn', '[GUI] busy — wait for the current GUI task to finish'); return false; }
    const profile = cfg?.profiles[name];
    if (!profile) {
        addLog('error', `[GUI] unknown profile "${name}" — configure config.gui.profiles.${name}`);
        return false;
    }
    busy = true;
    try {
        const already = currentMatchingWindow(profile.titleMatch);
        if (already) { addLog('system', `[GUI] profile "${name}" window already open`); return true; }
        return await openGui(profile);
    } finally {
        busy = false;
    }
}

/**
 * Run a named click sequence for a profile. Opens the GUI first if it isn't
 * already open. Returns true when every step succeeded.
 */
export async function runProfileAction(name: string, actionName: string): Promise<boolean> {
    if (busy) { addLog('warn', '[GUI] busy — wait for the current GUI task to finish'); return false; }
    const profile = cfg?.profiles[name];
    if (!profile) {
        addLog('error', `[GUI] unknown profile "${name}" — configure config.gui.profiles.${name}`);
        return false;
    }
    const action = profile.actions[actionName];
    if (!action) {
        addLog('error', `[GUI] profile "${name}" has no action "${actionName}" (available: ${Object.keys(profile.actions).join(', ') || 'none'})`);
        return false;
    }

    busy = true;
    try {
        let alreadyOpen = currentMatchingWindow(profile.titleMatch) !== null;
        if (!alreadyOpen) {
            addLog('system', `[GUI] opening "${name}" for action "${actionName}"`);
            alreadyOpen = await openGui(profile);
        }
        if (!alreadyOpen) return false;
        return await runAction(profile, action, true);
    } finally {
        busy = false;
    }
}
