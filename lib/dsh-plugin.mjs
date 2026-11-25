/**
 * pdf2png-cn 的 DSH（DeepSeek Harness）插件入口。
 *
 * 标准 cordis 插件：
 *   - `name`   插件名（与 package.json name / cordis.patch.yml 的 id 一致）
 *   - `inject` 只依赖 tools 服务
 *   - `apply`  注册模型可调用的 pdf2png_convert 工具
 *
 * 核心渲染在 lib/index.js（ESM + MuPDF WASM）。CLI 在 bin/pdf2png.js。
 * DSH 里安装本包后，模型就能直接把 PDF 转成图片（例如交给视觉模型 OCR）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  convert,
  collectInputs,
  normalizeFormat,
  version,
} from './index.js';

export const name = 'pdf2png-cn';
export const inject = ['tools'];

const TOOL = 'pdf2png_convert';

/** 插件配置里可给工具参数设默认值的键（与工具参数同名）。 */
export const DEFAULT_OPTION_KEYS = [
  'dpi', 'format', 'quality', 'out_dir', 'prefix', 'pages',
  'min_digits', 'skip_existing', 'overwrite', 'password', 'recursive',
];

export const DEFAULT_OPTION_ALIASES = {
  'out-dir': 'out_dir',
  outDir: 'out_dir',
  'min-digits': 'min_digits',
  minDigits: 'min_digits',
  'skip-existing': 'skip_existing',
  skipExisting: 'skip_existing',
  ext: 'format',
};

/** 从 exec 上下文取会话工作目录；取不到退回插件配置 / 进程 cwd。 */
function workspaceRoot(exec, cfg) {
  const fromSession = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined;
  if (typeof fromSession === 'string' && fromSession.length > 0) return path.resolve(fromSession);
  if (typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.length > 0) return path.resolve(cfg.workspaceRoot);
  return process.cwd();
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 收集插件配置里的默认参数。
 *   config.defaults: { dpi: 300, format: "jpg" }
 * 也接受直接写在 config 顶层，defaults 优先级更高。
 */
export function collectDefaults(cfg) {
  const out = {};
  const layers = [];
  if (cfg && typeof cfg.defaults === 'object' && cfg.defaults !== null && !Array.isArray(cfg.defaults)) {
    layers.push(cfg.defaults);
  }
  if (cfg && typeof cfg === 'object') layers.push(cfg);
  for (const layer of layers) {
    for (const [rawKey, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      const key = DEFAULT_OPTION_ALIASES[rawKey] || rawKey;
      if (!DEFAULT_OPTION_KEYS.includes(key)) continue;
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = value;
    }
  }
  return out;
}

function readString(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${TOOL}: "${key}" 必须是字符串`);
  return value;
}

function readBoolean(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${TOOL}: "${key}" 必须是布尔值`);
  return value;
}

function readNumber(value, key) {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new Error(`${TOOL}: "${key}" 必须是数字`);
  return n;
}

/** 工具参数 → convert() 选项。 */
function toolOpts(raw, root) {
  const opts = {};

  const dpi = readNumber(raw.dpi, 'dpi');
  if (dpi !== undefined) opts.dpi = dpi;

  const quality = readNumber(raw.quality, 'quality');
  if (quality !== undefined) opts.quality = quality;

  const format = readString(raw.format, 'format');
  if (format !== undefined && format.trim() !== '') opts.format = normalizeFormat(format);

  const minDigits = readNumber(raw.min_digits, 'min_digits');
  if (minDigits !== undefined) opts.minDigits = minDigits;

  const pages = readString(raw.pages, 'pages');
  if (pages !== undefined && pages.trim() !== '') opts.pages = pages;

  const prefix = readString(raw.prefix, 'prefix');
  if (prefix !== undefined && prefix.trim() !== '') opts.prefix = prefix;

  const password = readString(raw.password, 'password');
  if (password !== undefined && password !== '') opts.password = password;

  const outDir = readString(raw.out_dir, 'out_dir');
  if (outDir !== undefined && outDir.trim() !== '') opts.outDir = path.resolve(root, outDir);

  const skipExisting = readBoolean(raw.skip_existing, 'skip_existing');
  const overwrite = readBoolean(raw.overwrite, 'overwrite');
  if (skipExisting === true) opts.overwrite = false;
  if (overwrite !== undefined) opts.overwrite = overwrite;

  return opts;
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const defaults = collectDefaults(cfg);

  const def = {
    name: TOOL,
    description:
      'Render each page of a PDF to PNG or JPEG images (MuPDF WASM — same engine as PyMuPDF, no Python, LaTeX or ' +
      'headless browser needed). Built for OCR/vision pipelines and for turning 试卷/讲义/报告 PDFs into images: ' +
      'Chinese text, formulas and images render faithfully. Output naming is <pdf-name>_[01].png (digits widen with ' +
      'page count), compatible with the classic pdf2png.py script. Supports selected pages ("1-3,5"), DPI, JPEG ' +
      'quality, recursive directory input, encrypted PDFs and skip-existing. Returns per-file image paths, pixel ' +
      'sizes and any failures.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: {
        input: {
          type: 'string',
          description: 'PDF 文件路径，或包含 PDF 的目录。相对路径按当前会话工作目录解析，也可以给绝对路径。',
        },
        dpi: {
          type: 'integer',
          minimum: 18,
          maximum: 1200,
          description: '渲染 DPI，默认 200。200 时 A4 约为 1656×2342。',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'jpg'],
          description: '输出格式，默认 png；jpeg/jpg 输出 .jpg。',
        },
        quality: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'JPEG 质量 1–100，默认 90（仅 jpeg 生效）。',
        },
        out_dir: {
          type: 'string',
          description: '输出目录。省略时写到 PDF 所在目录；相对路径按会话工作目录解析。目录不存在会自动创建。',
        },
        prefix: {
          type: 'string',
          description: '输出文件名前缀（默认 PDF 文件名）。批量/目录输入时不可用。',
        },
        pages: {
          type: 'string',
          description: '只渲染部分页，如 "1-3,5"、"2-"、"-3"；默认全部。',
        },
        min_digits: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          description: '页码最小位数，默认 2；总页数更多时自动加宽。',
        },
        skip_existing: {
          type: 'boolean',
          description: 'true 时跳过已存在的图片（默认覆盖）。',
        },
        overwrite: {
          type: 'boolean',
          description: '是否覆盖已存在图片，默认 true。skip_existing 为 true 时以跳过为准。',
        },
        recursive: {
          type: 'boolean',
          description: 'input 是目录时是否递归扫描子目录，默认 false。',
        },
        password: {
          type: 'string',
          description: '加密 PDF 的密码。',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw, exec) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${TOOL}: 参数必须是对象`);
      }

      const merged = { ...defaults, ...raw };
      const root = workspaceRoot(exec, cfg);

      const inputRaw = readString(merged.input, 'input');
      if (!inputRaw || inputRaw.trim() === '') throw new Error(`${TOOL}: "input" 不能为空`);
      const absIn = path.resolve(root, inputRaw);
      if (!fs.existsSync(absIn)) throw new Error(`${TOOL}: 输入路径不存在：${absIn}`);

      const recursive = readBoolean(merged.recursive, 'recursive') === true;
      let files;
      try {
        files = collectInputs([absIn], { recursive });
      } catch (error) {
        throw new Error(`${TOOL}: ${error.message}`);
      }
      if (files.length === 0) {
        throw new Error(`${TOOL}: 没有找到 PDF 文件：${absIn}${recursive ? '' : '（子目录需 recursive=true）'}`);
      }

      const opts = toolOpts(merged, root);
      if (opts.prefix && files.length > 1) {
        throw new Error(`${TOOL}: 批量转换时不能使用 prefix（文件名会互相覆盖），请使用默认文件名`);
      }

      const started = Date.now();
      const results = [];
      const failures = [];
      for (const file of files) {
        try {
          results.push(await convert(file, opts));
        } catch (error) {
          failures.push({
            pdfPath: file,
            message: error && error.message ? error.message : String(error),
          });
        }
      }

      if (results.length === 0) {
        const detail = failures.map((f) => `- ${path.basename(f.pdfPath)}：${f.message}`).join('\n');
        throw new Error(`${TOOL}: 全部 ${files.length} 个 PDF 都转换失败：\n${detail}`);
      }

      const elapsed = Date.now() - started;
      const totalImages = results.reduce((sum, result) => sum + result.images.length, 0);
      const totalSkipped = results.reduce((sum, result) => sum + result.skipped.length, 0);
      const outDirs = [...new Set(results.map((result) => result.outDir))];
      const displayPath = (abs) => (isInside(root, abs) ? path.relative(root, abs) : abs);

      const lines = [
        `已渲染 ${results.length} 个 PDF，共 ${totalImages} 张图片`
        + `（dpi=${results[0].dpi}, ${results[0].format}，耗时 ${(elapsed / 1000).toFixed(2)}s）`,
      ];
      if (totalSkipped > 0) lines.push(`跳过已存在：${totalSkipped} 张`);
      lines.push('');

      const MAX_LIST = 30;
      let listed = 0;
      let omitted = 0;
      for (const result of results) {
        const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 张` : '';
        lines.push(`- ${path.basename(result.pdfPath)}：${result.images.length} 张${skipped}（共 ${result.totalPages} 页）`);
        for (const image of result.images) {
          if (listed >= MAX_LIST) {
            omitted += 1;
            continue;
          }
          listed += 1;
          lines.push(`  · ${displayPath(image.path)}  ${image.width}×${image.height}`);
        }
      }
      if (omitted > 0) lines.push(`  … 另有 ${omitted} 张未列出`);
      lines.push('');
      lines.push(`输出目录：${outDirs.map(displayPath).join('、')}`);

      if (failures.length > 0) {
        lines.push('');
        lines.push(`失败 ${failures.length} 个：`);
        for (const failure of failures) {
          lines.push(`- ${path.basename(failure.pdfPath)}：${failure.message}`);
        }
      }

      const notes = [];
      if (!isInside(root, absIn)) notes.push(`输入路径在工作目录之外：${absIn}`);
      for (const outDir of outDirs) {
        if (!isInside(root, outDir)) notes.push(`输出目录在工作目录之外：${outDir}`);
      }
      if (results[0].dpi < 72) notes.push('dpi 低于 72，文字可能发虚；OCR 建议 150–300。');
      if (notes.length > 0) {
        lines.push('');
        lines.push(`提示（${notes.length} 条）：`);
        for (const note of notes) lines.push(`- ${note}`);
      }

      lines.push('');
      lines.push(`（pdf2png-cn ${version}）`);
      return lines.join('\n');
    },
  };

  ctx.tools.register(def);
}
