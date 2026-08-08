/**
 * header.tsx — opencode-style status bar for the bot.
 *
 * A single-line strip on top of the scrollback showing live telemetry pushed
 * by the engine through the core store: connection, ping, state, HP/food bars,
 * position, players, inventory, AI status and uptime.
 *
 * REACTIVITY NOTE: under Node, `solid-js` resolves to the server (SSR) build
 * whose runtime is NOT shared with @opentui/solid's reconciler (it bundles the
 * client build `solid-js/dist/solid.js`). We must import the client build
 * directly or signals/effects never connect. Because the react-jsx transform
 * evaluates props eagerly (and the getter-based babel transform is Bun-only),
 * updates are driven imperatively: a createSignal + createEffect write
 * content/fg straight onto the renderable nodes via refs.
 *
 * LAYOUT NOTE: each segment is a separate flex child with `flexShrink={0}` so
 * overflowing rows clip on the right (opencode-style) instead of shrinking
 * every node mid-word. Indicator chars are ASCII (`[x]`/`[ ]`): this OpenTUI
 * build measures U+25CF/`●` and block chars (`█`/`░`) as double-width and
 * corrupts the first frame when they lead a node, while `●`-style dots break
 * the test renderer's flip raster — ASCII is reliable in both.
 */
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js/dist/solid.js';
import { onTelemetry, getTelemetry, type TelemetrySnapshot } from '../core/store.ts';
import { theme, vitalityColor, bar, formatUptime } from './theme.ts';

const EMPTY: TelemetrySnapshot = {
    connected: false,
    server: '',
    username: '',
    ping: -1,
    players: 0,
    hp: 0,
    food: 0,
    pos: null,
    state: 'disconnected',
    invCount: 0,
    aiEnabled: false,
    uptime: 0,
};

type AnyNode = { content?: string; fg?: string | unknown };

export function Header(props: { serverInfo: string }) {
    const [snap, setSnap] = createSignal<TelemetrySnapshot | null>(getTelemetry());
    onCleanup(onTelemetry(setSnap));

    let dotEl: AnyNode;
    let stateEl: AnyNode;
    let hpEl: AnyNode;
    let foodEl: AnyNode;
    let posEl: AnyNode;
    let playersEl: AnyNode;
    let invEl: AnyNode;
    let aiEl: AnyNode;
    let upEl: AnyNode;

    const render = () => {
        const t = snap() ?? EMPTY;
        if (dotEl) {
            dotEl.content = t.connected ? `[x] ${t.ping >= 0 ? `${t.ping}ms` : '—'}` : '[ ] disconnected';
            dotEl.fg = t.connected ? theme.header.success : theme.header.error;
        }
        if (stateEl) {
            stateEl.content = t.state.toUpperCase();
            stateEl.fg = theme.state[t.state as keyof typeof theme.state] ?? theme.header.text;
        }
        if (hpEl) {
            hpEl.content = `HP ${bar(t.hp / 20)} ${t.hp.toFixed(1)}`;
            hpEl.fg = vitalityColor(t.hp);
        }
        if (foodEl) {
            foodEl.content = `Food ${bar(t.food / 20)} ${t.food}/20`;
            foodEl.fg = vitalityColor(t.food);
        }
        if (posEl) {
            posEl.content = t.pos
                ? `${Math.round(t.pos.x)} ${Math.round(t.pos.y)} ${Math.round(t.pos.z)}`
                : '';
            posEl.fg = theme.header.accent;
        }
        if (playersEl) playersEl.content = `P ${t.players}`;
        if (invEl) invEl.content = `Inv ${t.invCount}/36`;
        if (aiEl) {
            aiEl.content = t.aiEnabled ? 'AI ON' : 'AI OFF';
            aiEl.fg = t.aiEnabled ? theme.header.success : theme.header.error;
        }
        if (upEl) upEl.content = formatUptime(t.uptime);
    };

    onMount(render);
    createEffect(render);

    return (
        <box
            height={2}
            paddingX={1}
            style={{
                backgroundColor: theme.header.bg,
                border: ['bottom'],
                borderStyle: 'single',
                borderColor: theme.header.border,
            }}
        >
            <box flexDirection="row" gap={2} height={1} overflow="hidden">
                <text flexShrink={0} ref={(n: any) => { dotEl = n; }} fg={theme.header.error} />
                <text flexShrink={0} content={props.serverInfo} fg={theme.header.muted} />
                <text flexShrink={0} ref={(n: any) => { stateEl = n; }} />
                <text flexShrink={0} ref={(n: any) => { hpEl = n; }} />
                <text flexShrink={0} ref={(n: any) => { foodEl = n; }} />
                <text flexShrink={0} ref={(n: any) => { posEl = n; }} fg={theme.header.accent} />
                <text flexShrink={0} ref={(n: any) => { playersEl = n; }} fg={theme.header.muted} />
                <text flexShrink={0} ref={(n: any) => { invEl = n; }} fg={theme.header.muted} />
                <text flexShrink={0} ref={(n: any) => { aiEl = n; }} />
                <text flexShrink={0} ref={(n: any) => { upEl = n; }} fg={theme.header.muted} />
            </box>
        </box>
    );
}
