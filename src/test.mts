// Full regression test suite
import { BotState, getState, setState, onStateChange, resetState } from './src/modules/state.ts';
import { parseAIReply } from './src/modules/ai.ts';
import { sleep, getRandom } from './src/utils.ts';
import { initReconnect, triggerReconnect, resetReconnectAttempts } from './src/modules/connection.ts';

let totalPass = 0, totalFail = 0;

function assert(label: string, cond: boolean, got?: any, expected?: any) {
    if (cond) { console.log('  ✓', label); totalPass++; }
    else { console.log('  ✗', label, got !== undefined ? `(got ${JSON.stringify(got)}, want ${JSON.stringify(expected)})` : ''); totalFail++; }
}

async function section(name: string, fn: () => Promise<void>) {
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch(e: any) { console.log('  SECTION THREW:', e.message); totalFail++; }
}

// STATE MACHINE
await section('State Machine', async () => {
    resetState();
    assert('Initial state is IDLE', getState() === BotState.IDLE);

    const changes: string[] = [];
    const unsub = onStateChange((p, n) => changes.push(`${p}→${n}`));

    setState(BotState.FOLLOWING);
    assert('Transitions to FOLLOWING', getState() === BotState.FOLLOWING);
    setState(BotState.FOLLOWING); // no-op
    assert('Duplicate setState is no-op', changes.length === 1, changes.length, 1);
    setState(BotState.IDLE);
    assert('Transitions back to IDLE', getState() === BotState.IDLE);
    assert('Listener fired twice', changes.length === 2, changes.length, 2);
    assert('Change log correct', changes[1] === 'following→idle', changes[1]);
    unsub();
    setState(BotState.COLLECTING);
    assert('Unsub listener not called', changes.length === 2);
    resetState();
    assert('Reset returns to IDLE', getState() === BotState.IDLE);
});

// AI REPLY PARSER
await section('AI Reply Parser', async () => {
    let r = parseAIReply('Let me follow!\nFOLLOW Steve');
    assert('chatText extracted', r.chatText === 'Let me follow!', r.chatText);
    assert('FOLLOW action', r.actions[0]?.type === 'FOLLOW');
    assert('FOLLOW target', (r.actions[0] as any)?.target === 'Steve');

    const tests: [string, any][] = [
        ['SLEEP', { type: 'SLEEP' }],
        ['STOP', { type: 'STOP' }],
        ['OPEN_DOOR', { type: 'OPEN_DOOR' }],
        ['DROP_ALL', { type: 'DROP_ALL' }],
        ['WALK', { type: 'WALK' }],
        ['JUMP 3', { type: 'JUMP', amount: 3 }],
        ['JUMP bad', { type: 'JUMP', amount: 1 }],
        ['CROUCH 5', { type: 'CROUCH', seconds: 5 }],
        ['CROUCH -2', { type: 'CROUCH', seconds: 1 }],
        ['EAT bread', { type: 'EAT', item: 'bread' }],
        ['DROP oak_log 10', { type: 'DROP', item: 'oak_log', amount: 10 }],
        ['COLLECT wood 5', { type: 'COLLECT', args: 'wood 5' }],
        ['FOLLOW Alice', { type: 'FOLLOW', target: 'Alice' }],
    ];
    for (const [input, expected] of tests) {
        const a = parseAIReply(input).actions[0];
        assert(`Parse "${input}"`, JSON.stringify(a) === JSON.stringify(expected), a, expected);
    }

    r = parseAIReply('Hello there!');
    assert('Pure chat: no actions', r.actions.length === 0);
    assert('Pure chat: text preserved', r.chatText === 'Hello there!');

    r = parseAIReply('OK!\nFOLLOW Bob\nSure!\nJUMP 2');
    assert('Multi chatText joined', r.chatText === 'OK! Sure!', r.chatText);
    assert('Multi actions counted', r.actions.length === 2, r.actions.length, 2);

    // Empty / whitespace
    assert('Empty reply clean', parseAIReply('').chatText === '');
    assert('Whitespace reply clean', parseAIReply('  \n  ').chatText === '');
    assert('Padded SLEEP parsed', parseAIReply('  SLEEP  ').actions[0]?.type === 'SLEEP');
});

// UTILS
await section('Utils', async () => {
    const t0 = Date.now();
    await sleep(50);
    const elapsed = Date.now() - t0;
    assert('sleep ~50ms', elapsed >= 45 && elapsed < 300, elapsed);

    const arr = [10, 20, 30];
    let allValid = true;
    for (let i = 0; i < 50; i++) if (!arr.includes(getRandom(arr))) { allValid = false; break; }
    assert('getRandom valid', allValid);
    assert('getRandom single-item', getRandom(['x']) === 'x');
});

// CONNECTION MANAGER
await section('Connection Manager', async () => {
    let r = 0, gave = false;
    initReconnect({ maxAttempts: 3, delayMs: 5, onReconnect: () => r++, onGiveUp: () => { gave = true; } });
    await triggerReconnect(); await triggerReconnect(); await triggerReconnect(); await triggerReconnect();
    assert('Reconnected 3 times', r === 3, r, 3);
    assert('Gave up after max', gave === true);

    resetReconnectAttempts();
    let r2 = 0;
    initReconnect({ maxAttempts: 2, delayMs: 1, onReconnect: () => r2++, onGiveUp: () => {} });
    await triggerReconnect(); await triggerReconnect();
    assert('Reset allows fresh reconnects', r2 === 2, r2, 2);
});

// TEMPLATE FORMATTING
await section('Template Formatting', async () => {
    function fmt(t: string, v: Record<string, string>) {
        let o = t; for (const [k, val] of Object.entries(v)) o = o.replaceAll(`{${k}}`, val); return o;
    }
    assert('Single var', fmt('Hi {player}!', { player: 'Alice' }) === 'Hi Alice!');
    assert('Multi var', fmt('{amount} {item}', { amount: '5', item: 'wood' }) === '5 wood');
    assert('Missing var unchanged', fmt('Hi {player}', {}) === 'Hi {player}');
    assert('Multiple occurrences', fmt('{x} and {x}', { x: 'foo' }) === 'foo and foo');
});

// EDGE CASES
await section('Edge Cases', async () => {
    assert('Empty string action list', parseAIReply('').actions.length === 0);
    assert('Unknown action not parsed', parseAIReply('UNKNOWNACTION foo').actions.length === 0);
    assert('JUMP invalid defaults to 1', (parseAIReply('JUMP notanumber').actions[0] as any)?.amount === 1);
    assert('CROUCH negative clamped to 1', (parseAIReply('CROUCH -5').actions[0] as any)?.seconds === 1);
    assert('DROP_ALL has no extra fields', JSON.stringify(parseAIReply('DROP_ALL').actions[0]) === '{"type":"DROP_ALL"}');
});

console.log(`\n${'═'.repeat(52)}`);
console.log(`Results: ${totalPass} passed, ${totalFail} failed / ${totalPass + totalFail} total`);
if (totalFail === 0) console.log('🎉 ALL TESTS PASSED');
else { console.log(`❌ ${totalFail} FAILED`); process.exit(1); }
