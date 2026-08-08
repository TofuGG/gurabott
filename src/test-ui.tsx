// TUI interaction tests — verify the footer command prompt (typing, submit,
// history, Esc clear/exit, Ctrl+C exit) using OpenTUI's virtual test renderer.
import { testRender } from '@opentui/solid';
import { App } from './ui/app.tsx';

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

// Esc with empty buffer exits
await pressEsc();
assert('Esc on empty exits', exits === 1, exits, 1);

// Ctrl+C exits even with text in the buffer
await mockInput.typeText('quit-anyway');
await flush();
mockInput.pressCtrlC();
await flush();
assert('Ctrl+C exits with text present', exits === 2, exits, 2);

console.log(`\n${'═'.repeat(52)}`);
console.log(`TUI Results: ${totalPass} passed, ${totalFail} failed / ${totalPass + totalFail} total`);
if (totalFail === 0) console.log('TUI TESTS PASSED');
else { console.log(`FAILED: ${totalFail}`); process.exit(1); }
