#!/usr/bin/env node

/**
 * Gurabott - Customizable Minecraft AI Bot
 * Entry point for direct execution: `node index.js`
 *
 * All runtime logic (Node binary resolution, --experimental-ffi flags, tsx
 * bootstrap) lives in scripts/run.mjs so `npm start` and `node index.js`
 * behave identically on every OS.
 */

import './scripts/run.mjs';
