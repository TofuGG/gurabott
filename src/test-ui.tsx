// TUI interaction tests — verify the footer command prompt (typing, submit,
// history, Esc clear/exit, Ctrl+C exit) using OpenTUI's virtual test renderer.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testRender } from '@opentui/solid';
import { App } from './ui/app.tsx';
import { addLog } from './core/store.ts';
import { loadHistory } from './ui/history.ts';

let totalPass = 0, totalFail = 0;

function assert(label: string, cond: boolean, got?: any, expected?: any) {
    if (cond) { console.log('  ✓', label); totalPass++; }
    else { console.log('  ✗', label, got !== undefined ? `(got ${JSON.stringify(got)}, want ${JSON.stringify(expected)})` : ''); totalFail++; }
}

const calls: [string, string[]][] = [];
let exits = 0;

const setup = await testRender(
    () => <App
        serverInfo="127.0.0.1:25565 · Bot"
        onCommand={(c, a) => { calls.push([c, a]); }}
        onExit={() => { exits++; }}
    />,
    { width: 100, height: 24 },
);

const { mockInput, flush, captureCharFrame } = setup;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Lone ESC is buffered by the stdin parser and flushed as 'escape' only after
// its 20ms timeout, so press then let the clock advance before flushing.
const pressEsc = async () => { mockInput.pressEscape(); await sleep(40); await flush(); };

const footerLine = () => {
    const lines = captureCharFrame().split('\n');
    return lines[lines.length - 2] ?? '';
};
const PLACEHOLDER = 'Type a command';

await flush();

console.log('\n── TUI Scrollback Wrapping ──');
// Entries longer than the terminal width wrap onto additional physical rows
// instead of clipping at the right edge. (Placed before the exit tests: after
// Esc/Ctrl+C the test renderer stops painting the scrollback region.)
addLog('chat', 'WRAPTEST ' + 'x'.repeat(200) + ' ENDTAIL');
await flush();
await flush(); // let layout + virtualizer reconcile settle
const wrapRows = captureCharFrame().split('\n');
const headRow = wrapRows.findIndex(l => l.includes('WRAPTEST'));
const tailRow = wrapRows.findIndex(l => l.includes('ENDTAIL'));
assert('Wrapped head visible', headRow >= 0, headRow);
assert('Wrapped tail visible', tailRow >= 0, tailRow);
assert('Long entry wraps to multiple rows', tailRow > headRow, { headRow, tailRow });

console.log('\n── TUI Footer Input ──');

// Placeholder + hint visible
assert('Placeholder shown', footerLine().includes(PLACEHOLDER));
assert('Exit hint shown', footerLine().includes('quit'));

// Typing renders into the input
await mockInput.typeText('kick bob');
await flush();
assert('Typed text rendered', footerLine().includes('kick bob'));

// Enter submits the command
mockInput.pressEnter();
await flush();
assert('Enter submits command', calls.length === 1, calls.length, 1);
assert('Command name parsed', calls[0]?.[0] === 'kick', calls[0]?.[0]);
assert('Command args parsed', JSON.stringify(calls[0]?.[1]) === '["bob"]', calls[0]?.[1]);
assert('Input cleared after submit', footerLine().includes(PLACEHOLDER));
assert('Submitted text gone', !footerLine().includes('kick bob'));

// Empty submit is ignored
mockInput.pressEnter();
await flush();
assert('Empty submit ignored', calls.length === 1, calls.length, 1);

// History: up recalls last command, down clears
mockInput.pressArrow('up');
await flush();
assert('Up recalls history', footerLine().includes('kick bob'));
mockInput.pressEnter();
await flush();
assert('History resubmitted', calls.length === 2, calls.length, 2);
mockInput.pressArrow('down');
await flush();
assert('Down clears history', !footerLine().includes('kick bob'));

// Esc with text clears without exiting
await mockInput.typeText('partial');
await flush();
await pressEsc();
assert('Esc clears buffer', !footerLine().includes('partial'));
assert('Esc with text does not exit', exits === 0, exits, 0);

// Prompt still usable after Esc
await mockInput.typeText('ok');
await flush();
assert('Input usable after Esc', footerLine().includes('ok'));
await pressEsc();
assert('Esc clears again', !footerLine().includes('ok'));

// Esc with empty buffer arms a confirmation — it must NOT exit outright.
await pressEsc();
assert('Esc on empty arms confirm, no exit', exits === 0, exits, 0);
assert('Exit confirmation hint shown', footerLine().includes('Press ESC again'));

// Any other key cancels the pending exit confirmation.
mockInput.pressArrow('down');
await flush();
assert('Other key cancels confirm', exits === 0, exits, 0);
assert('Confirm hint cleared', !footerLine().includes('Press ESC again'));

// After a cancel, Esc arms again and a second Esc confirms the exit.
await pressEsc();
assert('Esc re-arms after cancel', exits === 0, exits, 0);
await pressEsc();
assert('Second Esc exits', exits === 1, exits, 1);

// Ctrl+C exits even with text in the buffer
await mockInput.typeText('quit-anyway');
await flush();
mockInput.pressCtrlC();
await flush();
assert('Ctrl+C exits with text present', exits === 2, exits, 2);

console.log('\n── TUI Command History Persistence ──');

// A fresh renderer with a fresh history file must start with an empty ring.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gura-history-'));
const histFile = path.join(tmpDir, 'history.json');

const setup2 = await testRender(
    () => <App
        serverInfo="127.0.0.1:25565 · Bot"
        historyFile={histFile}
        onCommand={(c, a) => { calls.push([c, a]); }}
        onExit={() => { exits++; }}
    />,
    { width: 100, height: 24 },
);
const { mockInput: mock2, flush: flush2, captureCharFrame: frame2 } = setup2;
const footerLine2 = () => {
    const lines = frame2().split('\n');
    return lines[lines.length - 2] ?? '';
};
await flush2();
assert('Fresh history file starts empty', !footerLine2().includes('persist-me'));

// Submit a command — it must land on disk for the next session.
await mock2.typeText('persist-me arg');
await flush2();
mock2.pressEnter();
await flush2();
const onDisk = loadHistory(histFile);
assert('Submitted command persisted to disk', onDisk.includes('persist-me arg'), onDisk);

// A brand-new renderer (new session) pointing at the same file must recall it.
setup2.renderer.destroy();
const setup3 = await testRender(
    () => <App
        serverInfo="127.0.0.1:25565 · Bot"
        historyFile={histFile}
        onCommand={(c, a) => { calls.push([c, a]); }}
        onExit={() => { exits++; }}
    />,
    { width: 100, height: 24 },
);
const { mockInput: mock3, flush: flush3, captureCharFrame: frame3 } = setup3;
const footerLine3 = () => {
    const lines = frame3().split('\n');
    return lines[lines.length - 2] ?? '';
};
await flush3();
mock3.pressArrow('up');
await flush3();
assert('New session recalls persisted command via ↑', footerLine3().includes('persist-me arg'), footerLine3());

// Persistence must survive a corrupt/missing file (best-effort, no crash).
setup3.renderer.destroy();
fs.writeFileSync(histFile, '{ not json');
const setup4 = await testRender(
    () => <App
        serverInfo="127.0.0.1:25565 · Bot"
        historyFile={histFile}
        onCommand={(c, a) => { calls.push([c, a]); }}
        onExit={() => { exits++; }}
    />,
    { width: 100, height: 24 },
);
const { flush: flush4 } = setup4;
await flush4();
assert('Corrupt history file does not crash', true);
setup4.renderer.destroy();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'═'.repeat(52)}`);
console.log(`TUI Results: ${totalPass} passed, ${totalFail} failed / ${totalPass + totalFail} total`);
if (totalFail === 0) console.log('TUI TESTS PASSED');
else { console.log(`FAILED: ${totalFail}`); process.exit(1); }
