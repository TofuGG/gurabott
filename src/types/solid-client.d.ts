/**
 * Typed bridge for the solid-js CLIENT build.
 *
 * Under Node the bare `solid-js` specifier resolves to the SSR/server build
 * (per solid-js's package.json `node` export condition), whose runtime is a
 * different module instance than the client build that @opentui/solid's
 * reconciler bundles from `solid-js/dist/solid.js`. Signals created in one
 * never reach computations in the other, so reactive components silently stop
 * updating. All TUI components therefore import reactivity primitives from the
 * client build directly. That file ships no typings, so we bridge to the
 * public `solid-js` types (identical API surface).
 */
declare module 'solid-js/dist/solid.js' {
    export * from 'solid-js';
}
