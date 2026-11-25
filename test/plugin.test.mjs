/**
 * DSH 插件入口测试：不加载 DSH，只验证注册的工具有效、能真实渲染。
 * 运行：node test/plugin.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, name, inject, collectDefaults } from '../lib/dsh-plugin.mjs';
import { version } from '../lib/index.js';
import { makePdf, makeBrokenPdf } from './make-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'test', 'tmp', 'plugin');

let passed = 0;
let failed = 0;

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed + failed} - ${title}`);
  } catch (error) {
    failed += 1;
    console.error(`\nnot ok ${passed + failed} - ${title}`);
    console.error(String(error && error.stack ? error.stack : error).split('\n').slice(0, 3).join('\n'));
  }
}

function loadPlugin(config) {
  let captured;
  const ctx = { tools: { register(def) { captured = def; } } };
  apply(ctx, config);
  assert.ok(captured, 'apply() 应注册工具');
  return captured;
}

function execAt(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

function exists(file) {
  return fs.existsSync(file);
}

async function main() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const sample = makePdf(path.join(tmp, 'sample.pdf'), { pages: 3 });
  const sample2 = makePdf(path.join(tmp, 'sample2.pdf'), { pages: 2 });
  const broken = makeBrokenPdf(path.join(tmp, 'broken.pdf'));

  console.log(`pdf2png-cn ${version} — plugin tests\n`);

  await test('插件元数据与工具定义', () => {
    assert.equal(name, 'pdf2png-cn');
    assert.deepEqual(inject, ['tools']);
    const def = loadPlugin();
    assert.equal(def.name, 'pdf2png_convert');
    assert.match(def.description, /MuPDF/);
    assert.equal(def.parameters.type, 'object');
    assert.deepEqual(def.parameters.required, ['input']);
    assert.equal(def.parameters.additionalProperties, false);
    assert.equal(def.parameters.properties.input.type, 'string');
    assert.equal(def.parameters.properties.dpi.maximum, 1200);
    assert.deepEqual(def.output.schema, { type: 'string' });
    assert.deepEqual(def.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }]);
  });

  await test('collectDefaults 别名与优先级', () => {
    const defaults = collectDefaults({
      defaults: { dpi: 300, format: 'jpg' },
      'out-dir': './png',
      minDigits: 3,
      ignore_me: true,
    });
    assert.deepEqual(defaults, { dpi: 300, format: 'jpg', out_dir: './png', min_digits: 3 });
  });

  await test('工具执行：单文件、输出目录与路径展示', async () => {
    const def = loadPlugin();
    const text = await def.execute(
      { input: 'sample.pdf', dpi: 36, out_dir: 'plugin-out' },
      execAt(tmp),
    );
    assert.match(text, /已渲染 1 个 PDF，共 3 张图片/);
    assert.match(text, /dpi=36, png/);
    assert.match(text, /plugin-out\/sample_\[01\]\.png/);
    for (let i = 1; i <= 3; i += 1) {
      assert.ok(exists(path.join(tmp, 'plugin-out', `sample_[0${i}].png`)), `缺少第 ${i} 页`);
    }
  });

  await test('工具执行：插件配置默认参数生效', async () => {
    const def = loadPlugin({ defaults: { dpi: 36, format: 'jpg' } });
    const text = await def.execute(
      { input: 'sample.pdf', pages: '1', out_dir: 'plugin-defaults' },
      execAt(tmp),
    );
    assert.match(text, /dpi=36, jpeg/);
    assert.ok(exists(path.join(tmp, 'plugin-defaults', 'sample_[01].jpg')));
  });

  await test('工具执行：目录递归与批量', async () => {
    const dir = path.join(tmp, 'in-dir');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(sample, path.join(dir, 'a.pdf'));
    fs.copyFileSync(sample2, path.join(sub, 'b.pdf'));

    const def = loadPlugin();
    const text = await def.execute(
      { input: 'in-dir', dpi: 36, recursive: true, pages: '1', out_dir: 'plugin-batch' },
      execAt(tmp),
    );
    assert.match(text, /已渲染 2 个 PDF，共 2 张图片/);
    assert.ok(exists(path.join(tmp, 'plugin-batch', 'a_[01].png')));
    assert.ok(exists(path.join(tmp, 'plugin-batch', 'b_[01].png')));
  });

  await test('工具执行：全部失败时抛错', async () => {
    const def = loadPlugin();
    const text = await def.execute(
      { input: 'broken.pdf', dpi: 36, out_dir: 'plugin-fail' },
      execAt(tmp),
    ).then(() => null, (error) => error);
    assert.ok(text instanceof Error, '单个损坏文件应抛错');
    assert.match(text.message, /全部 1 个 PDF 都转换失败/);
    assert.match(text.message, /渲染失败/);
  });

  await test('工具执行：部分失败时仍返回结果并列出失败项', async () => {
    const dir = path.join(tmp, 'in-mixed');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sample, path.join(dir, 'sample.pdf'));
    fs.copyFileSync(broken, path.join(dir, 'broken.pdf'));

    const def = loadPlugin();
    const text = await def.execute(
      { input: 'in-mixed', dpi: 36, pages: '1', out_dir: 'plugin-mixed' },
      execAt(tmp),
    );
    assert.match(text, /已渲染 1 个 PDF，共 1 张图片/);
    assert.match(text, /失败 1 个/);
    assert.match(text, /渲染失败/);
  });

  await test('工具执行：不存在的输入与批量 prefix 校验', async () => {
    const def = loadPlugin();
    await assert.rejects(
      def.execute({ input: 'missing.pdf' }, execAt(tmp)),
      /输入路径不存在/,
    );
    await assert.rejects(
      def.execute({ input: 'in-dir', recursive: true, prefix: 'x' }, execAt(tmp)),
      /不能使用 prefix/,
    );
    await assert.rejects(
      def.execute({ input: '', }, execAt(tmp)),
      /不能为空/,
    );
  });

  await test('工具执行：跳过已存在', async () => {
    const def = loadPlugin();
    await def.execute(
      { input: 'sample.pdf', dpi: 36, pages: '1', out_dir: 'plugin-skip' },
      execAt(tmp),
    );
    const text = await def.execute(
      { input: 'sample.pdf', dpi: 36, pages: '1', out_dir: 'plugin-skip', skip_existing: true },
      execAt(tmp),
    );
    assert.match(text, /跳过已存在：1 张/);
    assert.match(text, /共 0 张图片/);
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
