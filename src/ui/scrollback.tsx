/**
 * scrollback.tsx — virtualized, styled log feed.
 *
 * Each log entry is rendered as ONE cell-tall row: a muted timestamp span
 * followed by a span colored by entry kind (theme.entry). Rows live in a
 * fixed-capacity pool of absolutely-positioned `<text>` nodes inside a content
 * box whose height tracks the total entry count, so the ScrollBox scrollbar
 * and scrollTop behave as if every entry were mounted.
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
import { createSignal, onCleanup, onMount } from 'solid-js/dist/solid.js';
import { onLog, getLogs, MAX_LOG_ENTRIES, type LogEntry } from '../core/store.ts';
import { theme } from './theme.ts';

const OVERSCAN = 5;
const POOL_SIZE = 100;

function fmtTime(ts: number): string {
    return `${new Date(ts).toLocaleTimeString('en-US', { hour12: false })} `;
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
    const [entries, setEntries] = createSignal<readonly LogEntry[]>(getLogs());
    onCleanup(
        onLog((entry) => {
            // Cap the UI mirror at the same limit the store enforces — an
            // unbounded local array would leak memory and grow the virtualizer
            // count forever on long sessions.
            setEntries((prev) => {
                const next = [...prev, entry];
                if (next.length > MAX_LOG_ENTRIES) next.splice(0, next.length - MAX_LOG_ENTRIES);
                return next;
            });
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
        const list = entries();
        for (let k = 0; k < slots.length; k++) {
            const slot = slots[k];
            const item = items[k];
            if (item && item.index < list.length) {
                const e = list[item.index];
                if (!slot.row.visible) slot.row.visible = true;
                if (slot.row.top !== item.start) slot.row.top = item.start;
                const t = fmtTime(e.ts);
                if (slot.ts.children?.[0] !== t) { slot.ts.children = [t]; slot.ts.fg = theme.scrollback.timestamp; }
                if (slot.text.children?.[0] !== e.text) { slot.text.children = [e.text]; slot.text.fg = theme.entry[e.type]; }
            } else if (slot.row.visible) {
                slot.row.visible = false;
            }
        }
    };

    const sync = (): void => {
        if (!scrollboxEl) return;
        const n = entries().length;
        const viewport = scrollboxEl.height ?? 0;
        const rawTop = scrollboxEl.scrollTop ?? 0;

        if (n === lastCount && viewport === lastViewport && rawTop === lastScrollTop) return;

        lastCount = n;
        lastViewport = viewport;
        lastScrollTop = rawTop;

        scrollEl.scrollHeight = n;
        scrollEl.offsetWidth = scrollboxEl.width ?? 80;
        scrollEl.offsetHeight = viewport;
        scrollEl.scrollTop = rawTop;

        virtualizer.setOptions({ ...baseOpts, count: n });
        virtualizer._willUpdate();
        if (rectCb) rectCb({ width: scrollEl.offsetWidth, height: viewport });
        if (offsetCb) offsetCb(rawTop, false);
        (virtualizer as any).maybeNotify();

        // The content box height is the real ScrollBox's scrollSize, so it MUST
        // track the entry count on every sync. It cannot be left to
        // reconcile(): the virtualizer's onChange only fires when the visible
        // window shifts, so appends that stay in the same window would never
        // grow the content and the ScrollBox would clamp scrollTop to 0 (feed
        // appears frozen at the top). Stick-to-bottom is handled natively by
        // the ScrollBox's stickyScroll/stickyStart="bottom": every layout pass
        // re-pins the scrollbar to max(scrollHeight - viewport), and scrolling
        // away releases it until the user returns to the bottom.
        if (contentEl && contentEl.height !== n) contentEl.height = n;
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
