#!/usr/bin/env node
/**
 * pdf2png 命令行：把 PDF 逐页渲染成 PNG / JPEG。
 * 参数与旧版 pdf2png.py 兼容，并新增 --pages / --format / --quality / --json 等。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  convert,
  collectInputs,
  normalizeFormat,
  version,
} from '../lib/index.js';

const HELP = `pdf2png ${version} — PDF 逐页渲染为 PNG / JPEG（MuPDF，无需 Python）

用法:
  pdf2png <文件或目录...> [选项]

输出:
  默认写到 PDF 同目录：<文件名>_[01].png, <文件名>_[02].png ...

选项:
  -d, --dir              把输入都当作目录扫描（兼容旧脚本；目录本来就会自动扫描）
  -r, --recursive        递归扫描子目录
      --dpi <n>          渲染 DPI，默认 200（范围 18–1200）
  -o, --out <目录>       输出目录（默认 PDF 所在目录），别名 --out-dir
  -e, --ext <png|jpg>    输出格式，默认 png；--format 是它的新名字
      --quality <n>      JPEG 质量 1–100，默认 90
  -p, --pages <范围>     只渲染部分页，如 "1-3,5"、"2-"；默认全部
      --prefix <名称>     输出文件名前缀（默认 PDF 文件名；批量时不可用）
      --min-digits <n>   页码最小位数，默认 2（总页数更多时自动加宽）
      --skip-existing    跳过已存在的图片（默认覆盖）
      --password <密码>   加密 PDF 的密码
      --json             输出机器可读的 JSON 结果
      --debug            额外打印每张图片的路径与像素尺寸
      --quiet            只打印错误和最终汇总
  -h, --help             显示帮助
  -v, --version          显示版本

示例:
  pdf2png 试卷.pdf
  pdf2png 试卷.pdf --dpi 300 --format jpg --quality 95
  pdf2png ./pdfs --recursive --out ./pngs
  pdf2png a.pdf b.pdf --pages 1,3-5 --json

退出码:
  0 全部成功；1 有文件失败；2 参数或用法错误。
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    files: [],
    dirMode: false,
    recursive: false,
    dpi: 200,
    outDir: null,
    format: 'png',
    quality: 90,
    pages: null,
    prefix: null,
    minDigits: 2,
    overwrite: true,
    password: null,
    json: false,
    debug: false,
    quiet: false,
    help: false,
    showVersion: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (arg === '--') {
      opts.files.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      opts.files.push(arg);
      continue;
    }

    let inlineValue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (name) => {
      if (inlineValue !== undefined) return inlineValue;
      if (i + 1 >= argv.length) throw new UsageError(`参数 ${name} 缺少值`);
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.showVersion = true;
        break;
      case '-d':
      case '--dir':
        opts.dirMode = true;
        break;
      case '-r':
      case '--recursive':
        opts.recursive = true;
        break;
      case '--dpi':
        opts.dpi = value('--dpi');
        break;
      case '-o':
      case '--out':
      case '--out-dir':
      case '--outDir':
        opts.outDir = value(arg);
        break;
      case '-e':
      case '--ext':
      case '--format':
        opts.format = value(arg);
        break;
      case '--quality':
        opts.quality = value('--quality');
        break;
      case '-p':
      case '--pages':
        opts.pages = value('--pages');
        break;
      case '--prefix':
        opts.prefix = value('--prefix');
        break;
      case '--min-digits':
      case '--minDigits':
        opts.minDigits = value('--min-digits');
        break;
      case '--skip-existing':
      case '--skipExisting':
        opts.overwrite = false;
        break;
      case '--password':
        opts.password = value('--password');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--debug':
        opts.debug = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      default:
        throw new UsageError(`未知参数：${arg}`);
    }
  }

  return opts;
}

function toInt(value, name, min, max) {
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${name} 必须是 ${min}–${max} 之间的整数，收到：${value}`);
  }
  return n;
}

function printHelp(stream) {
  stream.write(HELP);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`pdf2png: ${error.message}\n`);
      printHelp(process.stderr);
      return 2;
    }
    throw error;
  }

  if (opts.help) {
    printHelp(process.stdout);
    return 0;
  }
  if (opts.showVersion) {
    console.log(version);
    return 0;
  }
  if (opts.files.length === 0) {
    console.error('pdf2png: 缺少输入文件或目录\n');
    printHelp(process.stderr);
    return 2;
  }

  try {
    opts.dpi = toInt(opts.dpi, '--dpi', 18, 1200);
    opts.quality = toInt(opts.quality, '--quality', 1, 100);
    opts.minDigits = toInt(opts.minDigits, '--min-digits', 1, 6);
    opts.format = normalizeFormat(opts.format);
    if (typeof opts.pages === 'string') opts.pages = opts.pages.trim() || null;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`pdf2png: ${error.message}`);
      return 2;
    }
    console.error(`pdf2png: ${error.message}`);
    return 2;
  }

  if (opts.dirMode) {
    for (const input of opts.files) {
      let stat;
      try {
        stat = fs.statSync(path.resolve(input));
      } catch {
        console.error(`pdf2png: 路径不存在：${path.resolve(input)}`);
        return 2;
      }
      if (!stat.isDirectory()) {
        console.error(`pdf2png: --dir 要求所有输入都是目录，但这是文件：${path.resolve(input)}`);
        return 2;
      }
    }
  }

  let files;
  try {
    files = collectInputs(opts.files, { recursive: opts.recursive });
  } catch (error) {
    console.error(`pdf2png: ${error.message}`);
    return 2;
  }

  if (files.length === 0) {
    console.error('pdf2png: 没有找到任何 PDF 文件');
    return 1;
  }
  if (opts.prefix && files.length > 1) {
    console.error('pdf2png: 批量转换时不能使用 --prefix（文件名会互相覆盖），请使用默认文件名');
    return 2;
  }

  const results = [];
  const errors = [];

  for (const file of files) {
    try {
      const result = await convert(file, {
        dpi: opts.dpi,
        format: opts.format,
        quality: opts.quality,
        outDir: opts.outDir,
        prefix: opts.prefix,
        pages: opts.pages,
        minDigits: opts.minDigits,
        overwrite: opts.overwrite,
        password: opts.password,
      });
      results.push(result);
      if (!opts.json && !opts.quiet) {
        const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 张已存在` : '';
        console.log(
          `✔ ${path.basename(file)} → ${result.images.length} 张${skipped}`
          + `（dpi=${result.dpi}, ${result.format}）→ ${result.outDir}`,
        );
        if (opts.debug) {
          for (const image of result.images) {
            console.log(`   ${image.path}  ${image.width}×${image.height}  ${(image.bytes / 1024).toFixed(0)} KiB`);
          }
          for (const skippedPath of result.skipped) {
            console.log(`   跳过 ${skippedPath}`);
          }
        }
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      errors.push({ pdfPath: path.resolve(file), message });
      if (!opts.json) console.error(`✖ ${path.basename(file)}：${message}`);
    }
  }

  const imageCount = results.reduce((sum, result) => sum + result.images.length, 0);
  const skippedCount = results.reduce((sum, result) => sum + result.skipped.length, 0);

  if (opts.json) {
    const payload = {
      version,
      dpi: opts.dpi,
      format: opts.format,
      outDir: opts.outDir ? path.resolve(opts.outDir) : null,
      ok: results.length,
      failed: errors.length,
      images: imageCount,
      skipped: skippedCount,
      results,
      errors,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const parts = [`共 ${files.length} 个 PDF`, `成功 ${results.length}`, `失败 ${errors.length}`, `输出 ${imageCount} 张`];
    if (skippedCount) parts.push(`跳过 ${skippedCount} 张`);
    console.log(parts.join('，') + '。');
  }

  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`pdf2png: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
