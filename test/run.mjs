/**
 * pdf2png-cn 核心与 CLI 测试。
 * 运行：npm test（或 node test/run.mjs）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  convert,
  convertMany,
  collectInputs,
  parsePages,
  normalizeFormat,
  Pdf2PngError,
  version,
} from '../lib/index.js';
import { makePdf, makeBrokenPdf } from './make-fixture.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'pdf2png.js');
const tmp = path.join(root, 'test', 'tmp');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed + failed} - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`\nnot ok ${passed + failed} - ${name}`);
    console.error(String(error && error.stack ? error.stack : error).split('\n').slice(0, 3).join('\n'));
  }
}

function exists(file) {
  return fs.existsSync(file);
}

function readHead(file, length) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, 0);
  fs.closeSync(fd);
  return buffer;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd ?? tmp,
    encoding: 'utf8',
    timeout: 120000,
  });
}

async function main() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const sample = makePdf(path.join(tmp, 'sample.pdf'), { pages: 3 });
  const sample2 = makePdf(path.join(tmp, 'sample2.pdf'), { pages: 2 });
  const broken = makeBrokenPdf(path.join(tmp, 'broken.pdf'));

  console.log(`pdf2png-cn ${version} — tests\n`);

  await test('parsePages 支持范围、开放区间、数组与去重', () => {
    assert.deepEqual(parsePages('1-3,5', 5), [1, 2, 3, 5]);
    assert.deepEqual(parsePages('1 - 3, 5', 5), [1, 2, 3, 5]);
    assert.deepEqual(parsePages('2-', 4), [2, 3, 4]);
    assert.deepEqual(parsePages('-3', 5), [1, 2, 3]);
    assert.deepEqual(parsePages([3, 1, 3], 3), [1, 3]);
    assert.deepEqual(parsePages('all', 2), [1, 2]);
    assert.deepEqual(parsePages(null, 2), [1, 2]);
    assert.deepEqual(parsePages('', 2), [1, 2]);
    assert.throws(() => parsePages('4', 3), /超出/);
    assert.throws(() => parsePages('3-1', 3), /起始页大于结束页/);
    assert.throws(() => parsePages('0', 3), /正整数/);
  });

  await test('normalizeFormat 接受 png/jpg/jpeg', () => {
    assert.equal(normalizeFormat('png'), 'png');
    assert.equal(normalizeFormat('JPG'), 'jpeg');
    assert.equal(normalizeFormat('jpeg'), 'jpeg');
    assert.throws(() => normalizeFormat('webp'), /不支持/);
  });

  await test('collectInputs 目录扫描、递归与去重', () => {
    const dir = path.join(tmp, 'inputs');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(sample, path.join(dir, 'a.pdf'));
    fs.copyFileSync(sample2, path.join(sub, 'b.pdf'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');

    assert.deepEqual(collectInputs(dir).map((f) => path.basename(f)), ['a.pdf']);
    assert.deepEqual(
      collectInputs(dir, { recursive: true }).map((f) => path.basename(f)),
      ['a.pdf', 'b.pdf'],
    );
    assert.equal(collectInputs([sample, sample]).length, 1);
    assert.throws(() => collectInputs(path.join(tmp, 'nope')), /不存在/);
  });

  await test('convert：默认命名、尺寸与 PNG 文件头', async () => {
    const outDir = path.join(tmp, 'basic');
    const result = await convert(sample, { dpi: 72, outDir });
    assert.equal(result.totalPages, 3);
    assert.equal(result.images.length, 3);
    assert.deepEqual(result.files.map((f) => path.basename(f)), [
      'sample_[01].png',
      'sample_[02].png',
      'sample_[03].png',
    ]);
    assert.equal(result.images[0].width, 612);
    assert.equal(result.images[0].height, 792);
    for (const image of result.images) {
      assert.ok(exists(image.path), `缺少输出：${image.path}`);
      assert.deepEqual(readHead(image.path, 8), PNG_MAGIC);
      assert.ok(image.bytes > 0);
    }
  });

  await test('convert：200 dpi 的 A4 倍率正确', async () => {
    const outDir = path.join(tmp, 'dpi200');
    const result = await convert(sample, { dpi: 200, outDir, pages: '1' });
    assert.equal(result.images[0].width, 1700);
    assert.equal(result.images[0].height, 2200);
  });

  await test('convert：只渲染指定页，编号保留真实页码', async () => {
    const outDir = path.join(tmp, 'pages');
    const result = await convert(sample, { dpi: 36, outDir, pages: '2,3' });
    assert.equal(result.totalPages, 3);
    assert.deepEqual(result.pages, [2, 3]);
    assert.deepEqual(result.files.map((f) => path.basename(f)), [
      'sample_[02].png',
      'sample_[03].png',
    ]);
    assert.equal(exists(path.join(outDir, 'sample_[01].png')), false);
  });

  await test('convert：JPEG 输出、质量与扩展名', async () => {
    const outDir = path.join(tmp, 'jpeg');
    const result = await convert(sample, {
      dpi: 36, outDir, format: 'jpg', quality: 70, pages: '1',
    });
    assert.equal(result.format, 'jpeg');
    assert.deepEqual(result.files.map((f) => path.basename(f)), ['sample_[01].jpg']);
    assert.deepEqual(readHead(result.files[0], 3), JPEG_MAGIC);
  });

  await test('convert：outDir + prefix + minDigits', async () => {
    const outDir = path.join(tmp, 'prefixed', 'nested');
    const result = await convert(sample, {
      dpi: 36, outDir, prefix: 'page', minDigits: 3, pages: '1',
    });
    assert.equal(result.files.length, 1);
    assert.equal(path.basename(result.files[0]), 'page_[001].png');
    assert.ok(exists(result.files[0]));
  });

  await test('convert：overwrite=false 跳过已存在文件', async () => {
    const outDir = path.join(tmp, 'skip');
    const first = await convert(sample, { dpi: 36, outDir, pages: '1' });
    assert.equal(first.images.length, 1);
    assert.equal(first.skipped.length, 0);

    const second = await convert(sample, { dpi: 36, outDir, pages: '1', overwrite: false });
    assert.equal(second.images.length, 0);
    assert.deepEqual(second.files, []);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0], first.images[0].path);

    const third = await convert(sample, { dpi: 36, outDir, pages: '1', overwrite: true });
    assert.equal(third.images.length, 1);
  });

  await test('convert：参数校验', async () => {
    await assert.rejects(convert(sample, { dpi: 5 }), Pdf2PngError);
    await assert.rejects(convert(sample, { dpi: 1300 }), /dpi/);
    await assert.rejects(convert(sample, { quality: 0 }), /quality/);
    await assert.rejects(convert(sample, { minDigits: 0 }), /minDigits/);
    await assert.rejects(convert(sample, { prefix: 'a/b' }), /分隔符/);
    await assert.rejects(convert(path.join(tmp, 'missing.pdf')), /不存在/);
    await assert.rejects(convert(tmp), /目录/);
  });

  await test('convert：损坏的 PDF 报渲染失败', async () => {
    await assert.rejects(convert(broken), /渲染失败/);
  });

  await test('convertMany：递归目录、汇总与单个失败不中断', async () => {
    const dir = path.join(tmp, 'batch');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(sample, path.join(dir, 'a.pdf'));
    fs.copyFileSync(sample2, path.join(sub, 'b.pdf'));

    const flat = await convertMany(dir, { dpi: 36, outDir: path.join(tmp, 'batch-out') });
    assert.equal(flat.files.length, 1);
    assert.equal(flat.ok, 1);

    const nested = await convertMany(dir, {
      dpi: 36,
      recursive: true,
      outDir: path.join(tmp, 'batch-out-rec'),
    });
    assert.equal(nested.ok, 2);
    assert.equal(nested.failed, 0);
    assert.equal(nested.totalImages, 5);

    const mixed = await convertMany([broken, sample], {
      dpi: 36,
      outDir: path.join(tmp, 'batch-mixed'),
      pages: '1',
    });
    assert.equal(mixed.ok, 1);
    assert.equal(mixed.failed, 1);
    assert.match(mixed.errors[0].message, /渲染失败/);
    assert.equal(mixed.totalImages, 1);
  });

  await test('CommonJS 入口：动态 import 封装', async () => {
    const cjs = require('../lib/index.cjs');
    assert.equal(cjs.version, version);
    const result = await cjs.convert(sample, { dpi: 36, pages: '1', outDir: path.join(tmp, 'cjs') });
    assert.equal(result.images.length, 1);
    assert.ok(exists(result.files[0]));
  });

  await test('CLI --json：输出结构化结果', () => {
    const outDir = path.join(tmp, 'cli-json');
    const run = runCli(['sample.pdf', '--json', '--dpi', '36', '--pages', '1-2', '--out', outDir]);
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, 1);
    assert.equal(payload.failed, 0);
    assert.equal(payload.images, 2);
    assert.equal(payload.results[0].files.length, 2);
    for (const file of payload.results[0].files) {
      assert.ok(path.isAbsolute(file));
      assert.ok(exists(file));
    }
  });

  await test('CLI --skip-existing', () => {
    const outDir = path.join(tmp, 'cli-skip');
    const first = runCli(['sample.pdf', '--json', '--dpi', '36', '--pages', '1', '--out', outDir]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).images, 1);

    const second = runCli([
      'sample.pdf', '--json', '--dpi', '36', '--pages', '1', '--out', outDir, '--skip-existing',
    ]);
    assert.equal(second.status, 0, second.stderr);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.images, 0);
    assert.equal(payload.skipped, 1);
  });

  await test('CLI --format jpg 与 --quality', () => {
    const outDir = path.join(tmp, 'cli-jpg');
    const run = runCli([
      'sample.pdf', '--json', '--dpi', '36', '--pages', '1', '--out', outDir,
      '--format', 'jpg', '--quality', '75',
    ]);
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.format, 'jpeg');
    assert.match(payload.results[0].files[0], /\.jpg$/);
    assert.deepEqual(readHead(payload.results[0].files[0], 3), JPEG_MAGIC);
  });

  await test('CLI 用法错误退出码为 2', () => {
    const noArgs = runCli([]);
    assert.equal(noArgs.status, 2);
    assert.match(noArgs.stderr, /缺少输入/);

    const unknown = runCli(['sample.pdf', '--nope']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /未知参数/);

    const badDpi = runCli(['sample.pdf', '--dpi', '9']);
    assert.equal(badDpi.status, 2);
    assert.match(badDpi.stderr, /--dpi/);

    const dirOnFile = runCli(['sample.pdf', '--dir']);
    assert.equal(dirOnFile.status, 2);
    assert.match(dirOnFile.stderr, /要求所有输入都是目录/);

    const prefixBatch = runCli([
      'sample.pdf', 'sample2.pdf', '--prefix', 'x', '--out', path.join(tmp, 'cli-prefix'),
    ]);
    assert.equal(prefixBatch.status, 2);
    assert.match(prefixBatch.stderr, /不能使用 --prefix/);
  });

  await test('CLI --help / --version', () => {
    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /用法/);
    assert.match(help.stdout, /--pages/);

    const v = runCli(['--version']);
    assert.equal(v.status, 0);
    assert.equal(v.stdout.trim(), version);
  });

  await test('CLI 页码越界：文件失败退出码 1', () => {
    const run = runCli([
      'sample.pdf', '--json', '--dpi', '36', '--pages', '9', '--out', path.join(tmp, 'cli-badpage'),
    ]);
    assert.equal(run.status, 1);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.failed, 1);
    assert.match(payload.errors[0].message, /超出/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\n调试产物保留在：${tmp}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
