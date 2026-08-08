/**
 * footer.tsx — bottom control surface with a live command prompt.
 *
 * An OpenTUI `<input>` owns the command line: type to edit, Enter to submit,
 * ↑/↓ to walk history. Esc clears the buffer (or exits when it's already
 * empty) and Ctrl+C exits unconditionally.
 *
 * KEY DISPATCH: OpenTUI delivers key events to global `keyInput` listeners
 * BEFORE the focused renderable (the input) gets them, so the `useKeyboard`
 * handlers here can act first and `key.stopPropagation()` to keep the input
 * from also processing arrows / escape.
 *
 * REACTIVITY NOTE: like header.tsx, the eager react-jsx transform evaluates
 * props once, so the input is driven imperatively through its node ref
 * (`inputEl.value`) rather than a controlled signal.
 */
import { useKeyboard } from '@opentui/solid';
import { onMount } from 'solid-js/dist/solid.js';
import { theme } from './theme.ts';

type AnyInput = { value: string; focus: () => void };

const HISTORY_LIMIT = 100;

export function Footer(props: { onCommand: (cmd: string, args: string[]) => void | Promise<void>; onExit: () => void }) {
    let inputEl: AnyInput | null = null;
    const history: string[] = [];
    let histIdx = -1;

    const setValue = (v: string): void => {
        if (inputEl && inputEl.value !== v) inputEl.value = v;
    };

    const submit = (raw: string): void => {
        const trimmed = raw.trim();
        setValue('');
        if (!trimmed) return;

        history.push(trimmed);
        if (history.length > HISTORY_LIMIT) history.shift();
        histIdx = -1;

        const parts = trimmed.split(/\s+/);
        void props.onCommand(parts[0], parts.slice(1));
    };

    useKeyboard((key) => {
        if (key.name === 'up') {
            key.stopPropagation();
            if (histIdx === -1) histIdx = history.length;
            if (histIdx > 0) {
                histIdx--;
                setValue(history[histIdx]);
            }
        } else if (key.name === 'down') {
            key.stopPropagation();
            if (histIdx !== -1) {
                histIdx++;
                if (histIdx >= history.length) {
                    histIdx = -1;
                    setValue('');
                } else {
                    setValue(history[histIdx]);
                }
            }
        } else if (key.name === 'escape') {
            if (inputEl && inputEl.value) {
                key.stopPropagation();
                setValue('');
            } else {
                props.onExit();
            }
        }
    });

    // Defensive: ensure the prompt owns keyboard focus once mounted.
    onMount(() => inputEl?.focus());

    return (
        <box
            height={2}
            paddingX={1}
            style={{ backgroundColor: theme.footer.bg, border: ['top'], borderStyle: 'single', borderColor: theme.footer.border }}
        >
            <box flexDirection="row" gap={1} height={1}>
                <text content="›" flexShrink={0} style={{ fg: theme.footer.prompt }} />
                <input
                    flexGrow={1}
                    focused
                    placeholder="Type a command — e.g. ghelp, status, quit"
                    placeholderColor={theme.footer.hint}
                    backgroundColor={theme.footer.bg}
                    focusedBackgroundColor={theme.footer.bg}
                    textColor={theme.footer.text}
                    focusedTextColor={theme.footer.text}
                    onSubmit={(v: any) => submit(typeof v === 'string' ? v : '')}
                    ref={(n: any) => { inputEl = n; }}
                />
                <text content="Enter run · ↑/↓ history · Esc/Ctrl+C quit" flexShrink={0} style={{ fg: theme.footer.hint }} />
            </box>
        </box>
    );
}
