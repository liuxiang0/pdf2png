/**
 * pdf2png-cn 核心：用 MuPDF（WASM 版，与 PyMuPDF 同引擎）把 PDF 逐页渲染成图片。
 *
 * 不依赖 Python、不依赖本机编译，Node.js 里直接跑。
 * 输出命名与旧版 pdf2png.py 完全兼容：
 *   <文件名>_[01].png, <文件名>_[02].png, ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 包版本（来自 package.json）。 */
export const version = require('../package.json').version;

/** 参数校验 / 输入错误。渲染引擎自身的错误会被包成普通 Error。 */
let mupdfPromise;

/** 懒加载 MuPDF WASM（约 14 MB）：只在真正渲染时初始化，不拖慢 DSH 启动。 */
async function loadMupdf() {
  if (!mupdfPromise) mupdfPromise = import('mupdf');
  return mupdfPromise;
}

export class Pdf2PngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Pdf2PngError';
  }
}

/** 支持输出格式 → 实际扩展名。 */
export const FORMAT_EXT = Object.freeze({ png: 'png', jpeg: 'jpg' });

/** 默认参数。库默认静默，CLI 负责打印。 */
export const DEFAULTS = Object.freeze({
  dpi: 200,
  format: 'png',
  quality: 90,
  outDir: null,
  prefix: null,
  pages: null,
  minDigits: 2,
  overwrite: true,
  password: null,
});

const DPI_MIN = 18;
const DPI_MAX = 1200;
const DIGITS_MIN = 1;
const DIGITS_MAX = 6;

/** 把 "png" / "jpg" / "jpeg" 统一成内部格式名。 */
export function normalizeFormat(format) {
  const value = String(format ?? 'png').trim().toLowerCase();
  if (value === 'png') return 'png';
  if (value === 'jpg' || value === 'jpeg' || value === 'jpe') return 'jpeg';
  throw new Pdf2PngError(`不支持的输出格式："${format}"（只支持 png / jpeg）`);
}

function normalizeInt(value, name, min, max) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Pdf2PngError(`${name} 必须是整数，收到：${value}`);
  }
  if (n < min || n > max) {
    throw new Pdf2PngError(`${name} 必须在 ${min}–${max} 之间，收到：${n}`);
  }
  return n;
}

/** 校验并补全单次转换的参数。 */
function normalizeOptions(options = {}) {
  const o = { ...DEFAULTS, ...options };
  o.dpi = normalizeInt(o.dpi, 'dpi', DPI_MIN, DPI_MAX);
  o.format = normalizeFormat(o.format);
  o.quality = normalizeInt(o.quality, 'quality', 1, 100);
  o.minDigits = normalizeInt(o.minDigits, 'minDigits', DIGITS_MIN, DIGITS_MAX);
  o.overwrite = o.overwrite !== false;
  if (o.outDir !== null && o.outDir !== undefined) {
    if (typeof o.outDir !== 'string' || o.outDir.trim() === '') {
      throw new Pdf2PngError('outDir 必须是非空字符串');
    }
    o.outDir = path.resolve(o.outDir);
  }
  if (o.prefix !== null && o.prefix !== undefined) {
    if (typeof o.prefix !== 'string' || o.prefix.trim() === '') {
      throw new Pdf2PngError('prefix 必须是非空字符串');
    }
    if (/[\\/]/.test(o.prefix)) {
      throw new Pdf2PngError('prefix 不能包含路径分隔符（/ 或 \\）');
    }
  }
  if (o.password !== null && o.password !== undefined && typeof o.password !== 'string') {
    throw new Pdf2PngError('password 必须是字符串');
  }
  return o;
}

/**
 * 解析页码范围。
 * @param {string|number|number[]|null} spec "all" / "1-3,5" / "2-" / "-3" / [1,3]
 * @param {number} totalPages PDF 总页数
 * @returns {number[]} 升序、去重、1 起始的页码
 */
export function parsePages(spec, totalPages) {
  const total = normalizeInt(totalPages, 'totalPages', 1, Number.MAX_SAFE_INTEGER);
  const raw = Array.isArray(spec) ? spec.join(',') : stringify(spec);
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'all') {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  // 允许 "1 - 3, 5" 这类带空格的写法。
  const chunks = trimmed.replace(/\s*-\s*/g, '-').split(/[,\s]+/).filter(Boolean);
  if (chunks.length === 0) {
    throw new Pdf2PngError('页码范围为空，请写成 "1-3,5" 或省略以渲染全部页面');
  }

  const selected = new Set();
  for (const chunk of chunks) {
    const s = String(chunk).trim();
    if (s === '') continue;
    if (s === 'all') {
      for (let i = 1; i <= total; i += 1) selected.add(i);
      continue;
    }
    const range = /^(\d*)\s*-\s*(\d*)$/.exec(s);
    if (range) {
      if (range[1] === '' && range[2] === '') {
        throw new Pdf2PngError(`页码范围无效："${s}"`);
      }
      const start = range[1] === '' ? 1 : Number(range[1]);
      const end = range[2] === '' ? total : Number(range[2]);
      if (start > end) {
        throw new Pdf2PngError(`页码范围起始页大于结束页："${s}"`);
      }
      if (end > total) {
        throw new Pdf2PngError(`页码超出 PDF 总页数（共 ${total} 页）："${s}"`);
      }
      for (let i = start; i <= end; i += 1) selected.add(i);
      continue;
    }
    if (!/^\d+$/.test(s)) {
      throw new Pdf2PngError(`无法识别的页码范围："${s}"，示例：1-3,5`);
    }
    addPage(selected, Number(s), total);
  }

  if (selected.size === 0) {
    throw new Pdf2PngError('没有选中任何页面');
  }
  return [...selected].sort((a, b) => a - b);
}

function stringify(value) {
  return value === null || value === undefined ? '' : String(value);
}

function addPage(set, page, total) {
  if (!Number.isInteger(page) || page < 1) {
    throw new Pdf2PngError(`页码必须是正整数，收到：${page}`);
  }
  if (page > total) {
    throw new Pdf2PngError(`页码超出 PDF 总页数（共 ${total} 页）：${page}`);
  }
  set.add(page);
}

/** 递归扫描目录里的 PDF（跳过隐藏项）。 */
function scanDir(dir, recursive, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Pdf2PngError(`无法读取目录 ${dir}：${error.message}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) scanDir(abs, recursive, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase().endsWith('.pdf')) out.push(path.resolve(abs));
  }
}

/**
 * 收集输入：文件原样保留，目录扫描其中（可递归）的 *.pdf；按解析后的绝对路径去重。
 * @param {string|string[]} inputs
 * @param {{recursive?: boolean}} [options]
 * @returns {string[]}
 */
export function collectInputs(inputs, options = {}) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const found = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Pdf2PngError('输入路径必须是非空字符串');
    }
    const abs = path.resolve(item);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Pdf2PngError(`路径不存在：${abs}`);
    }
    if (stat.isDirectory()) {
      scanDir(abs, options.recursive === true, found);
    } else if (stat.isFile()) {
      found.push(abs);
    } else {
      throw new Pdf2PngError(`不支持的输入类型：${abs}`);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const file of found) {
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

/**
 * 单个 PDF → 图片。
 * @param {string} pdfPath
 * @param {object} [options]
 * @param {number} [options.dpi=200] 渲染 DPI
 * @param {'png'|'jpeg'|'jpg'} [options.format='png']
 * @param {number} [options.quality=90] JPEG 质量（1–100）
 * @param {string} [options.outDir] 输出目录（默认与 PDF 同目录）
 * @param {string} [options.prefix] 文件名前缀（默认 PDF 文件名）
 * @param {string|number[]} [options.pages] 页码范围，如 "1-3,5"；默认全部
 * @param {number} [options.minDigits=2] 编号最小位数
 * @param {boolean} [options.overwrite=true] false 时跳过已存在的输出
 * @param {string} [options.password] 加密 PDF 的密码
 * @returns {Promise<{
 *   pdfPath: string, outDir: string, dpi: number, format: string,
 *   totalPages: number, pages: number[], files: string[], skipped: string[],
 *   images: {path: string, page: number, width: number, height: number, bytes: number}[]
 * }>}
 */
export async function convert(pdfPath, options = {}) {
  const opts = normalizeOptions(options);
  const absPdf = path.resolve(pdfPath);

  let stat;
  try {
    stat = fs.statSync(absPdf);
  } catch {
    throw new Pdf2PngError(`文件不存在：${absPdf}`);
  }
  if (stat.isDirectory()) {
    throw new Pdf2PngError(`是目录，请传入 PDF 文件或使用目录扫描：${absPdf}`);
  }
  if (!stat.isFile()) {
    throw new Pdf2PngError(`不是普通文件：${absPdf}`);
  }

  const outRoot = opts.outDir || path.dirname(absPdf);
  try {
    fs.mkdirSync(outRoot, { recursive: true });
  } catch (error) {
    throw new Pdf2PngError(`无法创建输出目录 ${outRoot}：${error.message}`);
  }

  const baseName = path.basename(absPdf, path.extname(absPdf));
  const prefix = opts.prefix || baseName;
  const ext = FORMAT_EXT[opts.format];
  const mupdf = await loadMupdf();
  const matrix = mupdf.Matrix.scale(opts.dpi / 72, opts.dpi / 72);

  let doc;
  try {
    doc = mupdf.Document.openDocument(fs.readFileSync(absPdf), 'application/pdf');

    if (doc.needsPassword()) {
      if (!opts.password) {
        throw new Pdf2PngError(`PDF 已加密，需要密码：${path.basename(absPdf)}`);
      }
      if (doc.authenticatePassword(opts.password) <= 0) {
        throw new Pdf2PngError(`PDF 密码不正确：${path.basename(absPdf)}`);
      }
    }

    const totalPages = doc.countPages();
    if (!Number.isInteger(totalPages) || totalPages <= 0) {
      throw new Pdf2PngError(`PDF 没有可渲染的页面：${path.basename(absPdf)}`);
    }

    const pages = parsePages(opts.pages, totalPages);
    const digits = Math.max(opts.minDigits, String(totalPages).length);
    for (const pageNo of pages) {
      if (pageNo > totalPages) {
        throw new Pdf2PngError(`页码超出 PDF 总页数（共 ${totalPages} 页）：${pageNo}`);
      }
    }

    const images = [];
    const skipped = [];
    for (const pageNo of pages) {
      const outPath = path.join(
        outRoot,
        `${prefix}_[${String(pageNo).padStart(digits, '0')}].${ext}`,
      );

      if (!opts.overwrite && fs.existsSync(outPath)) {
        skipped.push(outPath);
        continue;
      }

      const page = doc.loadPage(pageNo - 1);
      let pixmap;
      try {
        // PDF 页用 CropBox（与 PyMuPDF 的 page.rect 行为一致）；普通 Page 会忽略多余参数。
        pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true, 'View', 'CropBox');
        // 让 PNG 的 pHYs / JPEG 的密度信息记录 DPI。
        pixmap.setResolution(opts.dpi, opts.dpi);
        const data = opts.format === 'jpeg'
          ? pixmap.asJPEG(opts.quality)
          : pixmap.asPNG();
        fs.writeFileSync(outPath, data);
        images.push({
          path: outPath,
          page: pageNo,
          width: pixmap.getWidth(),
          height: pixmap.getHeight(),
          bytes: data.length,
        });
      } finally {
        if (pixmap) pixmap.destroy();
        page.destroy();
      }
    }

    return {
      pdfPath: absPdf,
      outDir: outRoot,
      dpi: opts.dpi,
      format: opts.format,
      totalPages,
      pages,
      files: images.map((image) => image.path),
      skipped,
      images,
    };
  } catch (error) {
    if (error instanceof Pdf2PngError) throw error;
    const message = error && error.message ? error.message : String(error);
    const wrapped = new Error(`渲染失败（${path.basename(absPdf)}）：${message}`, { cause: error });
    wrapped.code = error && error.code;
    throw wrapped;
  } finally {
    if (doc) {
      try {
        doc.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 批量转换。单个文件失败不会中断其它文件，失败信息进入 errors。
 * @param {string|string[]} inputs 文件或目录
 * @param {object} [options] 同 convert()，另支持 recursive / onFile(result, error)
 * @returns {Promise<{
 *   files: string[], results: object[], errors: {pdfPath: string, message: string}[],
 *   ok: number, failed: number, totalImages: number, skipped: number
 * }>}
 */
export async function convertMany(inputs, options = {}) {
  const files = collectInputs(inputs, { recursive: options.recursive === true });
  const results = [];
  const errors = [];
  let totalImages = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const result = await convert(file, options);
      results.push(result);
      totalImages += result.images.length;
      skipped += result.skipped.length;
      if (typeof options.onFile === 'function') options.onFile(result, null);
    } catch (error) {
      const failure = {
        pdfPath: file,
        message: error && error.message ? error.message : String(error),
      };
      errors.push(failure);
      if (typeof options.onFile === 'function') options.onFile(null, failure);
    }
  }

  return {
    files,
    results,
    errors,
    ok: results.length,
    failed: errors.length,
    totalImages,
    skipped,
  };
}
