/**
 * app.tsx — root component of the OpenTUI interface.
 *
 * opencode-style split-footer layout:
 *   ┌────────────────────────────┐
 *   │  Header (live status bar)  │
 *   ├────────────────────────────┤
 *   │  Scrollback (log feed)     │  ← grows to fill
 *   ├────────────────────────────┤
 *   │  Footer (input/status)     │
 *   └────────────────────────────┘
 */
import { useKeyboard } from '@opentui/solid';
import { Header } from './header.tsx';
import { Scrollback } from './scrollback.tsx';
import { Footer } from './footer.tsx';
import { theme } from './theme.ts';

export type CommandHandler = (cmd: string, args: string[]) => void | Promise<void>;

export function App(props: { serverInfo: string; onCommand: CommandHandler; onExit: () => void }) {
    // Ctrl+C exits unconditionally — even mid-typing. Global key listeners run
    // before the focused input processes the key, so this fires reliably.
    useKeyboard((key) => {
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            key.stopPropagation();
            props.onExit();
        }
    });

    return (
        <box flexDirection="column" width="100%" height="100%" style={{ backgroundColor: theme.background }}>
            <Header serverInfo={props.serverInfo} />
            <Scrollback />
            <Footer onCommand={props.onCommand} onExit={props.onExit} />
        </box>
    );
}
