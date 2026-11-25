'use strict';
/**
 * CommonJS 兼容入口。
 *
 * 核心实现 lib/index.js 是 ESM（依赖 mupdf 的 WASM ESM 包），
 * 所以这里用动态 import() 懒加载，并只提供异步封装。
 * 同步工具（collectInputs / parsePages 等）请使用 ESM 入口：
 *   import { collectInputs } from 'pdf2png-cn/core';
 *
 * 用法：
 *   const { convert } = require('pdf2png-cn');
 *   await convert('a.pdf', { dpi: 200 });
 */
const { version } = require('../package.json');

const load = () => import('./index.js');
const call = (name) => (...args) => load().then((mod) => mod[name](...args));

module.exports = {
  version,
  ready: load,
  convert: call('convert'),
  convertMany: call('convertMany'),
};
