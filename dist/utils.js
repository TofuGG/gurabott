"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRandom = exports.sleep = void 0;
const sleep = (ms) => new Promise(resovle => setTimeout(resovle, ms));
exports.sleep = sleep;
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
exports.getRandom = getRandom;
