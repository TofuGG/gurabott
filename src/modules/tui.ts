/**
 * tui.ts - Interactive terminal UI for Gurabott
 *
 * Windows Terminal / PowerShell double-input fix:
 *  - process.stdin.setRawMode(true) before blessed starts stops the terminal
 *    from echoing characters on its own.
 *  - We do NOT use blessed.textbox at all. Input is a plain Box widget whose
 *    content we manage manually from screen.on('keypress').
 *  - screen.program.disableGpm() suppresses any secondary mouse/input daemon.
 */

import blessed from 'blessed';
import { BotState, getState, onStateChange } from './state.ts';
import type { Bot } from 'mineflayer';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TUILog {
    type: 'chat' | 'system' | 'error' | 'state' | 'ai' | 'movement' | 'warn';
    text: string;
    ts: number;
}
type CommandHandler = (cmd: string, args: string[]) => void | Promise<void>;

// ── Constants ─────────────────────────────────────────────────────────────────

const RIGHT_W = 28;
const HEADER_H = 3;
const INPUT_H = 3;
const CMD_H = 16;

const COMMANDS: { label: string; cmd: string }[] = [
    { label: 'gping       - ping',        cmd: 'gping'      },
    { label: 'gfollow <p> - follow',      cmd: 'gfollow '   },
    { label: 'gsfollow    - stop',        cmd: 'gsfollow'   },
    { label: 'gcollect <r>- collect',     cmd: 'gcollect '  },
    { label: 'gscollect   - stop',        cmd: 'gscollect'  },
    { label: 'gsleep      - sleep',       cmd: 'gsleep'     },
    { label: 'gkill <t>   - attack',      cmd: 'gkill '     },
    { label: 'gcraft <i>  - craft',       cmd: 'gcraft '    },
    { label: 'ginvsee     - inventory',   cmd: 'ginvsee'    },
    { label: 'gdump       - drop all',    cmd: 'gdump'      },
    { label: 'gcords      - coords',      cmd: 'gcords'     },
    { label: 'gopendoor   - door',        cmd: 'gopendoor'  },
    { label: 'gsurv       - survival',    cmd: 'gsurv'      },
    { label: 'gsurv stop  - stop surv',   cmd: 'gsurv stop' },
    { label: 'gsay <msg>  - chat',        cmd: 'gsay '      },
    { label: 'ghelp       - all cmds',    cmd: 'ghelp'      },
];

const SUPPRESSED = ['[STUCK]', '[MovementAI]'];
function isSuppressed(text: string) { return SUPPRESSED.some(p => text.includes(p)); }

// ── Module state ──────────────────────────────────────────────────────────────

let screen:   blessed.Widgets.Screen | null = null;
let logBox:   blessed.Widgets.Log    | null = null;
let statsBox: blessed.Widgets.Box    | null = null;
let inputBox: blessed.Widgets.Box    | null = null;
let cmdList:  blessed.Widgets.List   | null = null;
let headerBox:blessed.Widgets.Box    | null = null;
let helpBox:  blessed.Widgets.Box    | null = null;

let botRef:         Bot | null         = null;
let commandHandler: CommandHandler | null = null;
let inputHistory:   string[]           = [];
let historyIdx      = -1;
let inputBuf        = '';
let showHelp        = false;
let connected       = false;
let aiEnabled       = false;
let serverInfo      = '';

// ── Helpers ───────────────────────────────────────────────────────────────────

const hpColor   = (v: number) => v > 14 ? '{green-fg}' : v > 7 ? '{yellow-fg}' : '{red-fg}';
const foodColor = (v: number) => v > 14 ? '{green-fg}' : v > 7 ? '{yellow-fg}' : '{red-fg}';
const hpBar     = (v: number, max = 20) => { const f = Math.round((v/max)*10); return '█'.repeat(f)+'░'.repeat(10-f); };
const uptime    = (s: number) => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return h?`${h}h ${m}m`:`${m}m ${sec}s`; };
const end       = (c: string) => c.replace('{','{/');

const STATE_COLORS: Record<BotState, string> = {
    [BotState.IDLE]:       '{green-fg}',
    [BotState.FOLLOWING]:  '{cyan-fg}',
    [BotState.COLLECTING]: '{yellow-fg}',
    [BotState.FLEEING]:    '{red-fg}',
    [BotState.EATING]:     '{magenta-fg}',
    [BotState.SLEEPING]:   '{blue-fg}',
    [BotState.ATTACKING]:  '{red-fg}',
};

const BADGES: Record<TUILog['type'], string> = {
    chat:     '{bold}{white-fg}[CHAT]{/white-fg}{/bold}',
    system:   '{bold}{cyan-fg}[SYS]{/cyan-fg}{/bold}',
    error:    '{bold}{red-fg}[ERR]{/red-fg}{/bold}',
    state:    '{bold}{yellow-fg}[STATE]{/yellow-fg}{/bold}',
    ai:       '{bold}{magenta-fg}[AI]{/magenta-fg}{/bold}',
    movement: '{bold}{green-fg}[MOV]{/green-fg}{/bold}',
    warn:     '{bold}{yellow-fg}[WARN]{/yellow-fg}{/bold}',
};
const COLORS: Record<TUILog['type'], string> = {
    chat: '{white-fg}', system: '{cyan-fg}', error: '{red-fg}',
    state: '{yellow-fg}', ai: '{magenta-fg}', movement: '{green-fg}', warn: '{yellow-fg}',
};

function buildHeader() {
    const ai = aiEnabled ? '{green-fg}[AI ON]{/green-fg}' : '{red-fg}[AI OFF]{/red-fg}';
    return ` {bold}{cyan-fg}🤖 GURABOTT{/bold}{/cyan-fg}  ${ai}  {white-fg}${serverInfo}{/white-fg}`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initTUI(opts: { onCommand: CommandHandler; aiEnabled: boolean; serverInfo: string }): void {
    commandHandler = opts.onCommand;
    aiEnabled      = opts.aiEnabled;
    serverInfo     = opts.serverInfo;

    // ── Key fix for Windows Terminal double-echo ──────────────────────────────
    // Put stdin into raw mode BEFORE blessed creates its own program.
    // This prevents the terminal from echoing characters independently.
    if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); } catch {}
    }
    process.stdin.resume();

    screen = blessed.screen({
        smartCSR:    true,
        title:       'Gurabott',
        fullUnicode: true,
        dockBorders: true,
        autoPadding: false,
        // Do NOT set terminal: 'xterm' — let blessed detect it
    });

    // Disable GPM mouse daemon (can cause duplicate events on some terminals)
    try { (screen as any).program?.disableGpm?.(); } catch {}

    screen.enableMouse();

    buildLayout();
    setupKeypress();

    onStateChange((_p, n) => { addLog('state', `State → ${n}`); renderStats(); });
    screen.render();
    setInterval(renderStats, 1500);
}

// ── Layout ────────────────────────────────────────────────────────────────────

function buildLayout(): void {
    if (!screen) return;

    headerBox = blessed.box({
        parent: screen, top: 0, left: 0, width: '100%', height: HEADER_H,
        content: buildHeader(), tags: true, border: { type: 'line' },
        style: { fg: 'cyan', bg: 'black', border: { fg: 'cyan' } },
    });

    logBox = blessed.log({
        parent: screen, top: HEADER_H, left: 0, right: RIGHT_W, bottom: INPUT_H,
        label: ' {bold}Log{/bold} ', tags: true, border: { type: 'line' },
        style: { fg: 'white', bg: 'black', border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
        scrollable: true, alwaysScroll: true, mouse: true,
        scrollbar: { ch: '│', track: { bg: 'black' }, style: { bg: 'cyan' } },
        padding: { left: 1, right: 0, top: 0, bottom: 0 },
    });

    statsBox = blessed.box({
        parent: screen, top: HEADER_H, right: 0, width: RIGHT_W, bottom: INPUT_H + CMD_H,
        label: ' {bold}Stats{/bold} ', tags: true, border: { type: 'line' },
        style: { fg: 'white', bg: 'black', border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
    });

    cmdList = blessed.list({
        parent: screen, right: 0, width: RIGHT_W, bottom: INPUT_H, height: CMD_H,
        label: ' {bold}Commands{/bold} ', tags: true, border: { type: 'line' },
        style: {
            fg: 'white', bg: 'black',
            border: { fg: 'blue' }, label: { fg: 'blue', bold: true },
            selected: { fg: 'black', bg: 'cyan' },
        },
        items: COMMANDS.map(c => c.label),
        mouse: true, keys: false, scrollable: true, vi: false,
        scrollbar: { ch: '│', style: { bg: 'blue' }, track: { bg: 'black' } },
    });

    (cmdList as any).on('select', (_item: any, index: number) => {
        const entry = COMMANDS[index];
        if (!entry) return;
        inputBuf = entry.cmd;
        renderInput();
    });

    // Plain box — we write to it manually, no inputOnFocus, no keys
    inputBox = blessed.box({
        parent: screen, bottom: 0, left: 0, right: RIGHT_W, height: INPUT_H,
        label: ' {bold}{green-fg}Command{/green-fg}{/bold}  Enter=send  ↑↓=history  PgUp/Dn=scroll ',
        tags: true, border: { type: 'line' },
        style: { fg: 'white', bg: 'black', border: { fg: 'green' }, label: { fg: 'green', bold: true } },
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
    });

    blessed.box({
        parent: screen, bottom: 0, right: 0, width: RIGHT_W, height: INPUT_H,
        content: ' {cyan-fg}[F1]{/cyan-fg} Help\n {cyan-fg}[ESC]{/cyan-fg} Quit',
        tags: true, border: { type: 'line' },
        style: { fg: 'white', bg: 'black', border: { fg: 'blue' } },
    });

    helpBox = blessed.box({
        parent: screen, top: 'center', left: 'center', width: 64, height: 38,
        label: ' {bold}{yellow-fg} Help — press F1 to close {/yellow-fg}{/bold} ', tags: true,
        border: { type: 'line' },
        style: { fg: 'white', bg: 'black', border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true } },
        content: buildHelpContent(), hidden: true,
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
        scrollable: true, mouse: true, alwaysScroll: true,
        scrollbar: { ch: '│', style: { bg: 'yellow' } },
    });

    renderInput();
}

function renderInput(): void {
    inputBox?.setContent(inputBuf + '{blink}_{/blink}');
    screen?.render();
}

// ── Keypress ──────────────────────────────────────────────────────────────────

function setupKeypress(): void {
    if (!screen) return;

    screen.on('keypress', async (ch: string | undefined, key: any) => {
        const name: string = key?.name ?? '';

        // Global hotkeys — always fire first
        if (name === 'f1') {
            showHelp = !showHelp;
            showHelp ? (helpBox?.show(), helpBox?.setFront()) : helpBox?.hide();
            screen!.render();
            return;
        }
        if (name === 'escape' || (key?.ctrl && name === 'c')) {
            if (showHelp) { showHelp = false; helpBox?.hide(); screen!.render(); return; }
            showQuitDialog();
            return;
        }
        if (showHelp) return;

        // Input editing
        if (name === 'enter' || name === 'return') {
            const line = inputBuf.trim();
            inputBuf  = '';
            historyIdx = -1;
            renderInput();
            if (!line) return;
            if (inputHistory[0] !== line) inputHistory.unshift(line);
            if (inputHistory.length > 100) inputHistory.pop();
            addLog('system', `> ${line}`);
            const [cmd, ...args] = line.split(/\s+/);
            if (commandHandler) {
                try { await commandHandler(cmd.toLowerCase(), args); }
                catch (e: any) { addLog('error', `Error: ${e?.message ?? e}`); }
            }
            return;
        }

        if (name === 'backspace') { inputBuf = inputBuf.slice(0, -1); renderInput(); return; }
        if (name === 'up')   { historyIdx = Math.min(historyIdx+1, inputHistory.length-1); inputBuf = inputHistory[historyIdx] ?? ''; renderInput(); return; }
        if (name === 'down') { historyIdx = Math.max(historyIdx-1, -1); inputBuf = historyIdx === -1 ? '' : (inputHistory[historyIdx] ?? ''); renderInput(); return; }
        if (name === 'pageup')   { logBox?.scroll(-10); screen!.render(); return; }
        if (name === 'pagedown') { logBox?.scroll(10);  screen!.render(); return; }
        if (name === 'tab' || name === 'delete') return;

        if (ch && ch.length === 1 && !key?.ctrl && !key?.meta) {
            inputBuf += ch;
            renderInput();
        }
    });
}

// ── Quit dialog ───────────────────────────────────────────────────────────────

function showQuitDialog(): void {
    if (!screen) return;
    const overlay = blessed.box({
        parent: screen, top: 'center', left: 'center', width: 38, height: 9,
        border: { type: 'line' }, tags: true,
        style: { bg: 'black', border: { fg: 'red' } },
        content: '\n  {red-fg}{bold}Really quit Gurabott?{/bold}{/red-fg}\n',
    });
    const yes = blessed.button({
        parent: overlay, bottom: 1, left: 3, width: 12, height: 1,
        content: '{center}[ Yes ]{/center}', tags: true, mouse: true, keys: true,
        style: { fg: 'white', bg: 'red', hover: { bg: 'white', fg: 'black' }, focus: { bg: 'white', fg: 'black' } },
    });
    const no = blessed.button({
        parent: overlay, bottom: 1, right: 3, width: 12, height: 1,
        content: '{center}[  No ]{/center}', tags: true, mouse: true, keys: true,
        style: { fg: 'white', bg: 'blue', hover: { bg: 'white', fg: 'black' }, focus: { bg: 'white', fg: 'black' } },
    });
    const close = () => { overlay.destroy(); screen!.render(); };
    yes.on('press', () => { destroyTUI(); process.exit(0); });
    no.on('press', close);
    yes.focus();
    screen.render();
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function renderStats(): void {
    if (!statsBox || !screen) return;
    const s  = getState();
    const sc = STATE_COLORS[s] ?? '{white-fg}';
    const bot = botRef;

    if (!bot || !connected) {
        statsBox.setContent(`{bold}CONNECTION{/bold}\n{red-fg}● Disconnected{/red-fg}\n\n{bold}STATE{/bold}\n${sc}${s.toUpperCase()}${end(sc)}`);
        screen.render(); return;
    }

    const hp   = bot.health ?? 0;
    const food = bot.food ?? 0;
    const pos  = bot.entity?.position;
    const ping = bot.player?.ping ?? -1;
    const pls  = Object.keys(bot.players ?? {}).length;
    const inv  = bot.inventory?.items?.()?.length ?? 0;
    const hC   = hpColor(hp), fC = foodColor(food);

    statsBox.setContent([
        '{bold}CONNECTION{/bold}',
        `{green-fg}● Connected  ${ping}ms{/green-fg}`,
        `Players: {white-fg}${pls}{/white-fg}`,
        '', '{bold}HEALTH{/bold}',
        `${hC}${hpBar(hp)} ${hp.toFixed(1)}${end(hC)}`,
        '', '{bold}FOOD{/bold}',
        `${fC}${hpBar(food)} ${food}/20${end(fC)}`,
        '', '{bold}STATE{/bold}',
        `${sc}${s.toUpperCase()}${end(sc)}`,
        '', '{bold}POS{/bold}',
        pos ? `X {white-fg}${Math.round(pos.x)}{/white-fg}` : 'unknown',
        pos ? `Y {white-fg}${Math.round(pos.y)}{/white-fg}` : '',
        pos ? `Z {white-fg}${Math.round(pos.z)}{/white-fg}` : '',
        '', '{bold}INV{/bold}',
        `{white-fg}${inv}/36{/white-fg}`,
        '', '{bold}AI{/bold}',
        aiEnabled ? '{green-fg}On{/green-fg}' : '{red-fg}Off{/red-fg}',
        '', '{bold}UPTIME{/bold}',
        `{white-fg}${uptime(process.uptime())}{/white-fg}`,
    ].join('\n'));
    screen.render();
}

// ── Log API ───────────────────────────────────────────────────────────────────

export function addLog(type: TUILog['type'], text: string): void {
    if (isSuppressed(text)) return;
    if (!logBox || !screen) { process.stdout.write(`[${type.toUpperCase()}] ${text}\n`); return; }
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const c  = COLORS[type];
    logBox.log(`{gray-fg}${ts}{/gray-fg} ${BADGES[type]} ${c}${text}${end(c)}`);
    screen.render();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function attachBotToTUI(bot: Bot): void {
    botRef    = bot;
    connected = true;
    bot.on('end',    ()             => { connected = false; addLog('system', 'Disconnected'); renderStats(); });
    bot.on('login',  ()             => { connected = true;  addLog('system', `Logged in as ${bot.username}`); renderStats(); });
    bot.on('chat',   (u: string, m: string) => { if (u !== bot.username) addLog('chat', `<${u}> ${m}`); });
    bot.on('error',  (e: Error)     => addLog('error', `Bot error: ${e.message}`));
    bot.on('kicked', (r: string)    => { connected = false; addLog('error', `Kicked: ${r}`); renderStats(); });
}

export function setConnected(val: boolean): void { connected = val; renderStats(); }

export function updateAIStatus(enabled: boolean): void {
    aiEnabled = enabled;
    headerBox?.setContent(buildHeader());
    screen?.render();
}

export function destroyTUI(): void {
    try { screen?.destroy(); } catch {}
    screen = null;
}

export function interceptConsole(): void {
    const fmt = (a: any[]) => a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    console.log   = (...a) => addLog('system', fmt(a));
    console.warn  = (...a) => addLog('warn',   fmt(a));
    console.error = (...a) => addLog('error',  fmt(a));
}

function buildHelpContent(): string {
    return [
        '{bold}{cyan-fg}── GURABOTT COMMANDS ──────────────────{/bold}{/cyan-fg}',
        '',
        ' {cyan-fg}gping{/cyan-fg}             Ping',
        ' {cyan-fg}gsay <msg>{/cyan-fg}        Chat',
        ' {cyan-fg}ginvsee{/cyan-fg}           Inventory',
        ' {cyan-fg}gdump{/cyan-fg}             Drop all',
        ' {cyan-fg}gcords{/cyan-fg}            Coordinates',
        ' {cyan-fg}gtp <x> <y> <z>{/cyan-fg}  Teleport',
        ' {cyan-fg}gfollow <p>{/cyan-fg}       Follow player',
        ' {cyan-fg}gsfollow{/cyan-fg}          Stop following',
        ' {cyan-fg}gcraft <item>{/cyan-fg}     Craft item',
        ' {cyan-fg}gkill <target>{/cyan-fg}    Attack mob/player',
        ' {cyan-fg}gsleep{/cyan-fg}            Sleep in bed',
        ' {cyan-fg}gopendoor{/cyan-fg}         Open door',
        ' {cyan-fg}gcollect <r>{/cyan-fg}      Collect resources',
        ' {cyan-fg}gscollect{/cyan-fg}         Stop collecting',
        ' {cyan-fg}gjump <n>{/cyan-fg}         Jump n times',
        ' {cyan-fg}gcr <secs>{/cyan-fg}        Crouch N secs',
        ' {cyan-fg}geat <n> <amt>{/cyan-fg}    Eat by index',
        ' {cyan-fg}gdrop <n> <amt>{/cyan-fg}   Drop by index',
        ' {cyan-fg}glast{/cyan-fg}             Last joined player',
        ' {cyan-fg}ghelp{/cyan-fg}             In-game help',
        '',
        ' {yellow-fg}gsurv{/yellow-fg}            Start survival loop',
        ' {yellow-fg}gsurv stop{/yellow-fg}       Stop survival loop',
        '  Phases: wood→tools→stone→iron→diamond',
        '',
        '{bold}Keys:{/bold}',
        '  F1        Toggle help',
        '  ESC       Quit dialog',
        '  ↑ / ↓     Input history',
        '  PgUp/Dn   Scroll log',
        '  Enter     Send command',
        '',
        '{bold}Commands panel:{/bold}',
        '  Click any item → fills input.',
        '  Scroll list with mouse wheel.',
    ].join('\n');
}
