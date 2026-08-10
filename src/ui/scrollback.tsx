/**
 * scrollback.tsx — virtualized, styled log feed.
 *
 * Each log entry is rendered as ONE cell-tall row: a muted timestamp span
 * followed by a span colored by entry kind (theme.entry). Rows live in a
 * fixed-capacity pool of absolutely-positioned `<text>` nodes inside a content
 * box whose height tracks the total entry count, so the ScrollBox scrollbar
 * and scrollTop behave as if every entry were mounted.
 *
 * WRAPPING: entries longer than the terminal width are pre-broken (word-wrap,
 * with hard cuts for unbreakable tokens) into one display line per physical
 * row. The timestamp prefixes only the FIRST line of an entry; continuation
 * lines are indented to align under the timestamp column so wrapped text stays
 * visually grouped. Pre-wrapping keeps every virtual row a uniform 1 cell tall
 * and avoids depending on the renderer's internal wrap measurement.
 *
 * VIRTUALIZATION: @tanstack/virtual-core's Virtualizer is driven as a pure
 * imperative engine (the Solid adapter would resolve `solid-js` to the SSR
 * build and disconnect from the reconciler, and the eager react-jsx transform
 * can't do reactive `<For>` children). We bridge a fake scroll element:
 *   - viewport size -> observeElementRect callback,
 *   - scrollTop      -> observeElementOffset callback,
 *   - count          -> setOptions({ ...base, count }) (count MUST be a number
 *                       in this version; a function reference is never re-read).
 * The engine fires onChange() only when the visible window actually changes.
 *
 * DRIVE LOOP: the ScrollBox renderAfter hook runs on every frame the scrollbox
 * paints (including user scroll), and the onLog store handler runs on appends.
 * Both call sync(), which is a no-op unless count/viewport/scrollTop changed.
 * Stick-to-bottom is delegated to the ScrollBox's native stickyScroll /
 * stickyStart="bottom": it re-pins the scrollbar every layout pass while the
 * user is at the bottom, releases when they scroll up, and re-engages when
 * they scroll back down. sync() only mirrors the live scrollTop into the
 * virtualizer and keeps the content box height in step with the entry count.
 */
import { Virtualizer } from '@tanstack/virtual-core';
import { onCleanup, onMount } from 'solid-js/dist/solid.js';
import { onLog, getLogs, type LogEntry } from '../core/store.ts';
import { formatLogTime } from '../utils.ts';
import { theme } from './theme.ts';

const OVERSCAN = 5;
const POOL_SIZE = 100;

// toLocaleTimeString is ~50µs/call — far too slow to run per visible row per
// frame. Entries that land in the same wall-clock second render the same
// timestamp, so cache the formatted string by second. 600 slots covers a
// 10-minute scrollback window; anything older just recomputes.
const TIME_CACHE_MAX = 600;
const timeCache = new Map<number, string>();
function fmtTime(ts: number): string {
    const sec = Math.floor(ts / 1000);
    let out = timeCache.get(sec);
    if (out === undefined) {
        out = `${formatLogTime(ts)} `;
        if (timeCache.size >= TIME_CACHE_MAX) {
            timeCache.delete(timeCache.keys().next().value as number);
        }
        timeCache.set(sec, out);
    }
    return out;
}

// ── Wrapping ──────────────────────────────────────────────────────────────────
// "HH:MM:SS " prefix width in cells. Continuation lines indent by this much so
// the message text column stays aligned under the timestamp.
const TS_WIDTH = formatLogTime(Date.now()).length + 1;
const INDENT = ' '.repeat(TS_WIDTH);

// One display row: a single physical line, tagged with its source entry.
type DisplayLine = { entry: LogEntry; text: string; isFirst: boolean };

// ANSI (CSI/OSC) escape sequences render as zero-width.
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d/:#&=?%@~_-]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// East-Asian width heuristic: 2 for CJK/fullwidth/emoji, 0 for zero-width.
function charWidth(ch: string): number {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0 || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
    if (
        (c >= 0x1100 && c <= 0x115f) || c === 0x2329 || c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x1f300 && c <= 0x1faff) ||
        (c >= 0x1f900 && c <= 0x1f9ff) ||
        (c >= 0x20000 && c <= 0x2fffd) ||
        (c >= 0x30000 && c <= 0x3fffd)
    ) return 2;
    return 1;
}

function visibleWidth(s: string): number {
    let w = 0;
    for (const ch of s.replace(ANSI_RE, '')) w += charWidth(ch);
    return w;
}

/** Break `text` into physical lines that each fit in `width` cells. */
function wrapToLines(text: string, width: number): string[] {
    const W = Math.max(1, width);
    const out: string[] = [];

    for (const para of text.split('\n')) {
        if (para === '') { out.push(''); continue; }
        const tokens = para.match(/\s+|[^\s]+/g) ?? [];
        let line = '';
        let lineW = 0;
        const flush = () => { out.push(line); line = ''; lineW = 0; };

        for (const tok of tokens) {
            const tw = visibleWidth(tok);
            if (/^\s+$/.test(tok)) {
                // Whitespace: keep only when it fits and there's already text.
                if (line && lineW + tw <= W) { line += tok; lineW += tw; }
                continue;
            }
            if (tw > W) {
                // Unbreakable token wider than a full line: flush, hard-break.
                if (line) flush();
                let chunk = '';
                let cw = 0;
                for (const ch of [...tok]) {
                    const w = charWidth(ch);
                    if (cw + w > W && chunk) { out.push(chunk); chunk = ''; cw = 0; }
                    chunk += ch;
                    cw += w;
                }
                line = chunk;
                lineW = cw;
                continue;
            }
            if (line && lineW + tw > W) flush();
            line += tok;
            lineW += tw;
        }
        out.push(line);
    }
    return out;
}

type FakeScrollEl = {
    scrollTop: number;
    offsetWidth: number;
    offsetHeight: number;
    scrollHeight: number;
    addEventListener: () => void;
    removeEventListener: () => void;
    ownerDocument: { defaultView: typeof globalThis };
};

type Slot = { row: any; ts: any; text: any };

export function Scrollback() {
    onCleanup(
        onLog(() => {
            sync();
        }),
    );

    let scrollboxEl: any;
    let contentEl: any;
    const slots: Slot[] = [];
    const pushSlot = (i: number, field: keyof Slot, el: any): void => {
        slots[i] = slots[i] ?? { row: null, ts: null, text: null };
        slots[i][field] = el;
    };

    // ── wrapped display rows ─────────────────────────────────────────────────
    // `lines` mirrors `getLogs()` as one row per physical line (wrapped).
    // Rebuilt only on width change / ring-buffer trim; appended incrementally.
    const lines: DisplayLine[] = [];
    let builtWidth = -1;
    let trackedCount = 0;

    // Text cells available after the content-box's 1-cell padding each side and
    // the timestamp prefix.
    const textWidth = (viewportW: number): number =>
        Math.max(1, Math.floor(viewportW) - 2 - TS_WIDTH);

    const chunkEntry = (e: LogEntry, w: number): void => {
        const chunks = wrapToLines(e.text, w);
        for (let c = 0; c < chunks.length; c++) {
            lines.push({ entry: e, text: chunks[c], isFirst: c === 0 });
        }
    };

    const rebuild = (w: number): void => {
        lines.length = 0;
        for (const e of getLogs()) chunkEntry(e, w);
        builtWidth = w;
        trackedCount = lines.length > 0 ? getLogs().length : 0;
    };

    // ── virtualizer bridge ──────────────────────────────────────────────────
    let rectCb: ((r: { width: number; height: number }) => void) | null = null;
    let offsetCb: ((o: number, s: boolean) => void) | null = null;
    const scrollEl: FakeScrollEl = {
        scrollTop: 0, offsetWidth: 80, offsetHeight: 24, scrollHeight: 0,
        addEventListener: () => {}, removeEventListener: () => {},
        ownerDocument: { defaultView: globalThis },
    };

    const baseOpts = {
        getScrollElement: () => scrollEl,
        estimateSize: () => 1,
        scrollToFn: (offset: number): void => { scrollEl.scrollTop = Math.round(offset); },
        observeElementRect: (_i: any, cb: any) => { rectCb = cb; return () => {}; },
        observeElementOffset: (_i: any, cb: any) => { offsetCb = cb; return () => {}; },
        onChange: (inst: any): void => reconcile(inst),
        overscan: OVERSCAN,
    } as const;

    const virtualizer = new Virtualizer<any, any>({ ...baseOpts, count: 0 });

    let lastCount = -1;
    let lastViewport = 0;
    let lastScrollTop = 0;      // last scrollTop the change-detector saw

    const reconcile = (inst: any): void => {
        const items = inst.getVirtualItems();
        const total = inst.getTotalSize();
        if (contentEl && contentEl.height !== total) contentEl.height = total;
        // `lines` is rebuilt in place by sync(), so read it directly here.
        for (let k = 0; k < slots.length; k++) {
            const slot = slots[k];
            const item = items[k];
            if (item && item.index < lines.length) {
                const e = lines[item.index];
                if (!slot.row.visible) slot.row.visible = true;
                if (slot.row.top !== item.start) slot.row.top = item.start;
                const ts = e.isFirst ? fmtTime(e.entry.ts) : '';
                if (slot.ts.children?.[0] !== ts) { slot.ts.children = [ts]; slot.ts.fg = theme.scrollback.timestamp; }
                const text = e.isFirst ? e.text : `${INDENT}${e.text}`;
                if (slot.text.children?.[0] !== text) { slot.text.children = [text]; slot.text.fg = theme.entry[e.entry.type]; }
            } else if (slot.row.visible) {
                slot.row.visible = false;
            }
        }
    };

    const sync = (): void => {
        if (!scrollboxEl) return;
        const list = getLogs();
        const w = textWidth(scrollboxEl.width ?? 0);

        // Keep `lines` in sync with the store — cheap fast-path when nothing
        // changed: no loop runs, `lines` is untouched.
        if (w !== builtWidth) {
            rebuild(w);
        } else if (list.length > trackedCount) {
            for (let i = trackedCount; i < list.length; i++) chunkEntry(list[i], w);
            trackedCount = list.length;
        } else if (list.length < trackedCount || (list.length > 0 && lines[0]?.entry !== list[0])) {
            rebuild(w);
        }

        const count = lines.length;
        const viewport = scrollboxEl.height ?? 0;
        const rawTop = scrollboxEl.scrollTop ?? 0;

        if (count === lastCount && viewport === lastViewport && rawTop === lastScrollTop) return;

        lastCount = count;
        lastViewport = viewport;
        lastScrollTop = rawTop;

        scrollEl.scrollHeight = count;
        scrollEl.offsetWidth = scrollboxEl.width ?? 80;
        scrollEl.offsetHeight = viewport;
        scrollEl.scrollTop = rawTop;

        virtualizer.setOptions({ ...baseOpts, count });
        virtualizer._willUpdate();
        if (rectCb) rectCb({ width: scrollEl.offsetWidth, height: viewport });
        if (offsetCb) offsetCb(rawTop, false);
        (virtualizer as any).maybeNotify();

        // The content box height is the real ScrollBox's scrollSize, so it MUST
        // track the row count on every sync. It cannot be left to
        // reconcile(): the virtualizer's onChange only fires when the visible
        // window shifts, so appends that stay in the same window would never
        // grow the content and the ScrollBox would clamp scrollTop to 0 (feed
        // appears frozen at the top). Stick-to-bottom is handled natively by
        // the ScrollBox's stickyScroll/stickyStart="bottom": every layout pass
        // re-pins the scrollbar to max(scrollHeight - viewport), and scrolling
        // away releases it until the user returns to the bottom.
        if (contentEl && contentEl.height !== count) contentEl.height = count;
    };

    onMount(sync);

    return (
        <scrollbox
            scrollY
            stickyScroll
            stickyStart="bottom"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            ref={(n: any) => { scrollboxEl = n; }}
            style={{ backgroundColor: theme.scrollback.bg }}
            renderAfter={() => sync()}
        >
            <box
                ref={(n: any) => { contentEl = n; }}
                position="relative"
                width="100%"
                height={0}
                paddingX={1}
                style={{ backgroundColor: theme.scrollback.bg }}
            >
                {Array.from({ length: POOL_SIZE }).map((_, i) => (
                    <text
                        position="absolute"
                        top={0}
                        height={1}
                        width="100%"
                        selectable
                        visible={false}
                        ref={(n: any) => pushSlot(i, 'row', n)}
                    >
                        <span ref={(n: any) => pushSlot(i, 'ts', n)} />
                        <span ref={(n: any) => pushSlot(i, 'text', n)} />
                    </text>
                ))}
            </box>
        </scrollbox>
    );
}
