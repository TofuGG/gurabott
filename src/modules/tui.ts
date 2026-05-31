/**
 * tui.ts - Interactive terminal UI for Gurabott
 * Full-featured TUI with live stats, chat log, command input, and bot controls.
 */

import blessed from 'blessed';
import { BotState, getState, onStateChange } from './state.js';
import type { Bot } from 'mineflayer';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TUILog {
    type: 'chat' | 'system' | 'error' | 'state' | 'ai' | 'movement' | 'warn';
    text: string;
    ts: number;
}

type CommandHandler = (cmd: string, args: string[]) => void | Promise<void>;

// ── Colors ────────────────────────────────────────────────────────────────────

const C = {
    border:    '{bold}{cyan-fg}',
    title:     '{bold}{white-fg}',
    chat:      '{white-fg}',
    system:    '{cyan-fg}',
    error:     '{red-fg}',
    state:     '{yellow-fg}',
    ai:        '{magenta-fg}',
    movement:  '{green-fg}',
    warn:      '{yellow-fg}',
    label:     '{bold}{cyan-fg}',
    value:     '{white-fg}',
    good:      '{green-fg}',
    bad:       '{red-fg}',
    neutral:   '{yellow-fg}',
};

function typeColor(type: TUILog['type']): string {
    const map: Record<TUILog['type'], string> = {
        chat:     C.chat,
        system:   C.system,
        error:    C.error,
        state:    C.state,
        ai:       C.ai,
        movement: C.movement,
        warn:     C.warn,
    };
    return map[type] ?? C.chat;
}

function typeBadge(type: TUILog['type']): string {
    const badges: Record<TUILog['type'], string> = {
        chat:     '{bold}{white-fg}[CHAT]{/bold}{/white-fg}',
        system:   '{bold}{cyan-fg}[SYS]{/bold}{/cyan-fg}',
        error:    '{bold}{red-fg}[ERR]{/bold}{/red-fg}',
        state:    '{bold}{yellow-fg}[STATE]{/bold}{/yellow-fg}',
        ai:       '{bold}{magenta-fg}[AI]{/bold}{/magenta-fg}',
        movement: '{bold}{green-fg}[MOV]{/bold}{/green-fg}',
        warn:     '{bold}{yellow-fg}[WARN]{/bold}{/yellow-fg}',
    };
    return badges[type] ?? '{white-fg}[???]{/white-fg}';
}

// ── State ─────────────────────────────────────────────────────────────────────

let screen: blessed.Widgets.Screen | null = null;
let logBox: blessed.Widgets.Log | null = null;
let statsBox: blessed.Widgets.Box | null = null;
let inputBox: blessed.Widgets.Textbox | null = null;
let cmdList: blessed.Widgets.List | null = null;
let headerBox: blessed.Widgets.Box | null = null;
let footerBox: blessed.Widgets.Box | null = null;
let helpBox: blessed.Widgets.Box | null = null;

let botRef: Bot | null = null;
let commandHandler: CommandHandler | null = null;
let inputHistory: string[] = [];
let historyIndex = -1;
let logs: TUILog[] = [];
let statsUpdateInterval: NodeJS.Timeout | null = null;
let inputBuffer = '';
let showHelp = false;
let connected = false;
let aiEnabled = false;
let serverInfo = '';

const MAX_LOGS = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hpColor(hp: number): string {
    if (hp > 14) return '{green-fg}';
    if (hp > 7) return '{yellow-fg}';
    return '{red-fg}';
}

function foodColor(food: number): string {
    if (food > 14) return '{green-fg}';
    if (food > 7) return '{yellow-fg-}';
    return '{red-fg}';
}

function hpBar(value: number, max = 20): string {
    const filled = Math.round((value / max) * 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

function stateColor(s: BotState): string {
    const map: Record<BotState, string> = {
        [BotState.IDLE]:      '{green-fg}',
        [BotState.FOLLOWING]: '{cyan-fg}',
        [BotState.COLLECTING]:'{yellow-fg}',
        [BotState.FLEEING]:   '{red-fg}',
        [BotState.EATING]:    '{magenta-fg}',
        [BotState.SLEEPING]:  '{blue-fg}',
        [BotState.ATTACKING]: '{red-fg}',
    };
    return map[s] ?? '{white-fg}';
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initTUI(opts: {
    onCommand: CommandHandler;
    aiEnabled: boolean;
    serverInfo: string;
}): void {
    commandHandler = opts.onCommand;
    aiEnabled = opts.aiEnabled;
    serverInfo = opts.serverInfo;

    screen = blessed.screen({
        smartCSR: true,
        title: 'Gurabott',
        fullUnicode: true,
        forceUnicode: true,
        dockBorders: true,
        autoPadding: true,
    });

    buildLayout();
    setupInput();
    setupKeys();

    onStateChange((prev, next) => {
        addLog('state', `State: ${prev} → ${next}`);
        renderStats();
    });

    screen.render();
    setInterval(() => renderStats(), 1000);
}

function buildLayout(): void {
    if (!screen) return;

    // ── Header ──────────────────────────────────────────────────────────────
    headerBox = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: '100%',
        height: 3,
        content: buildHeader(),
        tags: true,
        style: {
            fg: 'cyan',
            bg: 'black',
            border: { fg: 'cyan' },
        },
        border: { type: 'line' },
    });

    // ── Stats panel (right column) ───────────────────────────────────────────
    statsBox = blessed.box({
        parent: screen,
        top: 3,
        right: 0,
        width: 28,
        height: '100%-8',
        content: '',
        tags: true,
        label: ' {bold}Stats{/bold} ',
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'cyan' },
            label: { fg: 'cyan', bold: true },
        },
        scrollable: false,
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
    });

    // ── Command quick-list (right column, bottom of stats) ───────────────────
    cmdList = blessed.list({
        parent: screen,
        bottom: 5,
        right: 0,
        width: 28,
        height: 14,
        label: ' {bold}Commands{/bold} ',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'blue' },
            label: { fg: 'blue', bold: true },
            selected: { fg: 'black', bg: 'cyan' },
        },
        items: [
            'gping          - ping',
            'gfollow <p>    - follow',
            'gsfollow       - stop follow',
            'gcollect <r>   - collect',
            'gscollect      - stop collect',
            'gsleep         - sleep',
            'gkill <target> - attack',
            'gcraft <item>  - craft',
            'ginvsee        - inventory',
            'gdump          - drop all',
            'gcords         - coords',
            'gopendoor      - open door',
            'gsay <msg>     - chat',
            'ghelp          - all cmds',
        ],
        mouse: false,
        keys: false,
        scrollable: false,
    });

    // ── Main log box ─────────────────────────────────────────────────────────
    logBox = blessed.log({
        parent: screen,
        top: 3,
        left: 0,
        right: 28,
        bottom: 5,
        label: ' {bold}Log{/bold} ',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'cyan' },
            label: { fg: 'cyan', bold: true },
            scrollbar: { bg: 'cyan' },
        },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: '│', track: { bg: 'black' }, style: { bg: 'cyan' } },
        padding: { left: 1, right: 0, top: 0, bottom: 0 },
        mouse: true,
    });

    // ── Input box ────────────────────────────────────────────────────────────
    inputBox = blessed.textbox({
        parent: screen,
        bottom: 0,
        left: 0,
        width: '100%-28',
        height: 3,
        label: ' {bold}Command{/bold} ',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'green' },
            label: { fg: 'green', bold: true },
            focus: { border: { fg: 'white' } },
        },
        inputOnFocus: true,
        keys: true,
        mouse: true,
        padding: { left: 1, right: 1 },
    });

    // ── Footer ───────────────────────────────────────────────────────────────
    footerBox = blessed.box({
        parent: screen,
        bottom: 0,
        right: 0,
        width: 28,
        height: 3,
        content: ' {cyan-fg}[F1]{/cyan-fg} Help  {cyan-fg}[ESC]{/cyan-fg} Quit',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'blue' },
        },
    });

    // ── Help overlay ─────────────────────────────────────────────────────────
    helpBox = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 60,
        height: 32,
        label: ' {bold}Help{/bold} ',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'black',
            border: { fg: 'yellow' },
            label: { fg: 'yellow', bold: true },
        },
        content: buildHelpContent(),
        hidden: true,
        padding: { left: 1, right: 1 },
        scrollable: true,
        mouse: true,
    });

    // Focus input
    inputBox.focus();
}

function buildHeader(): string {
    const aiTag = aiEnabled ? '{green-fg}[AI ON]{/green-fg}' : '{red-fg}[AI OFF]{/red-fg}';
    return ` {bold}{cyan-fg}🤖 GURABOTT{/bold}{/cyan-fg}  ${aiTag}  {white-fg}${serverInfo}{/white-fg}`;
}

function buildHelpContent(): string {
    return [
        '{bold}{cyan-fg}── GURABOTT HELP ─────────────────────────────{/bold}{/cyan-fg}',
        '',
        '{bold}Bot Commands (type in input box):{/bold}',
        '  {cyan-fg}gping{/cyan-fg}              Ping the server',
        '  {cyan-fg}ghelp{/cyan-fg}              Full help in-game',
        '  {cyan-fg}gsay <msg>{/cyan-fg}         Chat as bot',
        '  {cyan-fg}ginv{/cyan-fg}               Item count',
        '  {cyan-fg}ginvsee{/cyan-fg}            Full inventory',
        '  {cyan-fg}geat <n> <amt>{/cyan-fg}     Eat food by index',
        '  {cyan-fg}gjump <n>{/cyan-fg}          Jump n times',
        '  {cyan-fg}gdrop <n> <amt>{/cyan-fg}    Drop item by index',
        '  {cyan-fg}gdump{/cyan-fg}              Drop all items',
        '  {cyan-fg}gwalk{/cyan-fg}              Step forward',
        '  {cyan-fg}gcr <secs>{/cyan-fg}         Crouch for N seconds',
        '  {cyan-fg}gcords{/cyan-fg}             Print coordinates',
        '  {cyan-fg}gtp <x> <y> <z>{/cyan-fg}   Teleport',
        '  {cyan-fg}gfollow <player>{/cyan-fg}   Follow player',
        '  {cyan-fg}gsfollow{/cyan-fg}           Stop following',
        '  {cyan-fg}gcraft <item>{/cyan-fg}      Craft item',
        '  {cyan-fg}gkill <target>{/cyan-fg}     Attack mob/player',
        '  {cyan-fg}glast{/cyan-fg}              Last player joined',
        '  {cyan-fg}gsleep{/cyan-fg}             Sleep in bed',
        '  {cyan-fg}gopendoor{/cyan-fg}          Open nearest door',
        '  {cyan-fg}gcollect <r> <n>{/cyan-fg}   Collect resources',
        '  {cyan-fg}gscollect{/cyan-fg}          Stop collecting',
        '',
        '{bold}TUI Keys:{/bold}',
        '  {cyan-fg}F1{/cyan-fg}       Toggle this help',
        '  {cyan-fg}ESC{/cyan-fg}      Quit (with confirm)',
        '  {cyan-fg}↑/↓{/cyan-fg}      Input history',
        '  {cyan-fg}Enter{/cyan-fg}    Send command',
        '  {cyan-fg}PgUp/Dn{/cyan-fg}  Scroll log',
        '',
        '{bold}Log Colors:{/bold}',
        '  {white-fg}White{/white-fg}    = Chat',
        '  {cyan-fg}Cyan{/cyan-fg}     = System',
        '  {red-fg}Red{/red-fg}      = Error',
        '  {yellow-fg}Yellow{/yellow-fg}   = State',
        '  {magenta-fg}Magenta{/magenta-fg}  = AI',
        '  {green-fg}Green{/green-fg}    = Movement',
        '',
        '{cyan-fg}Press F1 to close help{/cyan-fg}',
    ].join('\n');
}

// ── Input & Keys ──────────────────────────────────────────────────────────────

function setupInput(): void {
    if (!inputBox || !screen) return;

    inputBox.key(['enter'], async () => {
        const raw = (inputBox as any).getValue?.() ?? '';
        const line = raw.trim();
        if (!line) return;

        (inputBox as any).clearValue?.();
        screen!.render();
        inputBox!.focus();

        // History
        if (inputHistory[0] !== line) inputHistory.unshift(line);
        if (inputHistory.length > 100) inputHistory.pop();
        historyIndex = -1;

        const parts = line.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        addLog('system', `> ${line}`);

        if (commandHandler) {
            try { await commandHandler(cmd, args); }
            catch (e: any) { addLog('error', `Command error: ${e?.message ?? e}`); }
        }
    });

    inputBox.key(['up'], () => {
        if (inputHistory.length === 0) return;
        historyIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
        const val = inputHistory[historyIndex] ?? '';
        (inputBox as any).setValue?.(val);
        screen!.render();
    });

    inputBox.key(['down'], () => {
        historyIndex = Math.max(historyIndex - 1, -1);
        const val = historyIndex === -1 ? '' : (inputHistory[historyIndex] ?? '');
        (inputBox as any).setValue?.(val);
        screen!.render();
    });

    inputBox.key(['pageup'], () => {
        logBox?.scroll(-10);
        screen!.render();
    });

    inputBox.key(['pagedown'], () => {
        logBox?.scroll(10);
        screen!.render();
    });
}

function setupKeys(): void {
    if (!screen) return;

    screen.key(['f1'], () => {
        showHelp = !showHelp;
        if (showHelp) {
            helpBox?.show();
            helpBox?.focus();
        } else {
            helpBox?.hide();
            inputBox?.focus();
        }
        screen!.render();
    });

    screen.key(['escape', 'q', 'C-c'], () => {
        if (showHelp) {
            showHelp = false;
            helpBox?.hide();
            inputBox?.focus();
            screen!.render();
            return;
        }
        // Confirm quit
        const dialog = blessed.question({
            parent: screen!,
            top: 'center',
            left: 'center',
            width: 40,
            height: 7,
            border: { type: 'line' },
            label: ' Confirm Quit ',
            tags: true,
            style: { border: { fg: 'red' }, label: { fg: 'red' } },
        });
        dialog.ask('{red-fg}Really quit Gurabott?{/red-fg}', (err, yes) => {
            if (yes) {
                destroyTUI();
                process.exit(0);
            } else {
                dialog.destroy();
                inputBox?.focus();
                screen!.render();
            }
        });
    });

    screen.key(['tab'], () => {
        inputBox?.focus();
    });
}

// ── Stats Renderer ────────────────────────────────────────────────────────────

function renderStats(): void {
    if (!statsBox || !screen) return;

    const bot = botRef;
    const state = getState();
    const sc = stateColor(state);

    if (!bot || !connected) {
        statsBox.setContent([
            '{bold}CONNECTION{/bold}',
            `{red-fg}● Disconnected{/red-fg}`,
            '',
            '{bold}STATE{/bold}',
            `${sc}${state.toUpperCase()}{/${sc.slice(1)}`,
        ].join('\n'));
        screen.render();
        return;
    }

    const hp = bot.health ?? 0;
    const food = bot.food ?? 0;
    const pos = bot.entity?.position;
    const ping = bot.player?.ping ?? -1;
    const players = Object.keys(bot.players ?? {}).length;
    const items = bot.inventory?.items?.()?.length ?? 0;
    const sc2 = sc.slice(1); // closing tag
    const hpC = hpColor(hp).slice(1);
    const foodC = foodColor(food).slice(1);

    const lines = [
        '{bold}CONNECTION{/bold}',
        `{green-fg}● Connected  ${ping}ms{/green-fg}`,
        `Players: {white-fg}${players}{/white-fg}`,
        '',
        '{bold}HEALTH{/bold}',
        `${hpColor(hp)}${hpBar(hp)} ${hp.toFixed(1)}{/${hpC}`,
        '',
        '{bold}FOOD{/bold}',
        `${foodColor(food)}${hpBar(food)} ${food}/20{/${foodC}`,
        '',
        '{bold}STATE{/bold}',
        `${sc}${state.toUpperCase()}{/${sc2}`,
        '',
        '{bold}POSITION{/bold}',
        pos ? `X: {white-fg}${Math.round(pos.x)}{/white-fg}` : 'unknown',
        pos ? `Y: {white-fg}${Math.round(pos.y)}{/white-fg}` : '',
        pos ? `Z: {white-fg}${Math.round(pos.z)}{/white-fg}` : '',
        '',
        '{bold}INVENTORY{/bold}',
        `{white-fg}${items}/36 slots{/white-fg}`,
        '',
        '{bold}AI{/bold}',
        aiEnabled ? '{green-fg}Enabled{/green-fg}' : '{red-fg}Disabled{/red-fg}',
        '',
        '{bold}UPTIME{/bold}',
        formatUptime(process.uptime()),
    ];

    statsBox.setContent(lines.join('\n'));
    screen.render();
}

function formatUptime(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `{white-fg}${h}h ${m}m ${s}s{/white-fg}`;
    if (m > 0) return `{white-fg}${m}m ${s}s{/white-fg}`;
    return `{white-fg}${s}s{/white-fg}`;
}

// ── Log API ───────────────────────────────────────────────────────────────────

export function addLog(type: TUILog['type'], text: string): void {
    const entry: TUILog = { type, text, ts: Date.now() };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();

    if (!logBox || !screen) {
        // Fallback to console if TUI not ready
        console.log(`[${type.toUpperCase()}] ${text}`);
        return;
    }

    const ts = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
    const color = typeColor(type);
    const endTag = color.replace('{', '{/').replace('-fg}', '-fg}');
    const badge = typeBadge(type);
    const line = `{gray-fg}${ts}{/gray-fg} ${badge} ${color}${text}{/${endTag.slice(2)}`;

    logBox.log(line);
    screen.render();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function attachBotToTUI(bot: Bot): void {
    botRef = bot;
    connected = true;

    bot.on('end', () => {
        connected = false;
        addLog('system', 'Disconnected from server');
        renderStats();
    });

    bot.on('login', () => {
        connected = true;
        addLog('system', `Logged in as ${bot.username}`);
        renderStats();
    });

    bot.on('chat', (username: string, message: string) => {
        if (username === bot.username) return;
        addLog('chat', `<${username}> ${message}`);
    });

    bot.on('error', (err: Error) => {
        addLog('error', `Bot error: ${err.message}`);
    });

    bot.on('kicked', (reason: string) => {
        connected = false;
        addLog('error', `Kicked: ${reason}`);
        renderStats();
    });
}

export function setConnected(val: boolean): void {
    connected = val;
    renderStats();
}

export function updateAIStatus(enabled: boolean): void {
    aiEnabled = enabled;
    if (headerBox) {
        headerBox.setContent(buildHeader());
        screen?.render();
    }
}

export function destroyTUI(): void {
    if (statsUpdateInterval) clearInterval(statsUpdateInterval);
    try { screen?.destroy(); } catch {}
    screen = null;
}

/**
 * Intercept console.log/warn/error so they route through TUI
 */
export function interceptConsole(): void {
    const orig = {
        log:   console.log.bind(console),
        warn:  console.warn.bind(console),
        error: console.error.bind(console),
    };

    console.log = (...args: any[]) => {
        const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        addLog('system', msg);
    };
    console.warn = (...args: any[]) => {
        const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        addLog('warn', msg);
    };
    console.error = (...args: any[]) => {
        const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        addLog('error', msg);
    };

    // Keep originals accessible
    (globalThis as any).__origConsole = orig;
}
