# pdf2png-cn

把 PDF **逐页渲染成 PNG / JPEG**，为 OCR、视觉模型和文档处理准备图片。

- **不需要 Python**：渲染引擎是 [MuPDF](https://mupdf.com/) 的官方 WebAssembly 构建（npm `mupdf`），与 PyMuPDF 同源，中文、公式、图片的渲染结果和 `pdf2png.py` 基本一致。
- **三种用法**：命令行 `pdf2png`、Node.js 库 API、[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 插件工具 `pdf2png_convert`。
- **命名兼容旧脚本**：`<文件名>_[01].png`、`<文件名>_[02].png` …… 现有流程不用改。

## 特性

| 能力 | 说明 |
| --- | --- |
| 逐页渲染 | 一页一张图，支持跳到指定页、页码范围 |
| PNG / JPEG | JPEG 可调质量；PNG 带 DPI 元数据 |
| DPI 可调 | 18–1200，默认 200（A4 ≈ 1656×2342） |
| 目录输入 | 自动扫描目录中的 PDF，可递归子目录 |
| 断点续跑 | `--skip-existing` 跳过已生成的图片 |
| 加密 PDF | `--password` 打开 |
| 结构化结果 | CLI `--json`，库返回每张图的路径/页码/像素尺寸/字节数 |
| 本地离线 | 渲染全在本机完成，不上传文件 |
| DSH 集成 | 安装后模型可直接调用，用于「PDF 转图片再 OCR」 |

## 安装

要求 Node.js ≥ 18。

```bash
# 只想要命令行
npm install -g pdf2png-cn

# 作为库 / DSH 插件装进某个项目
npm install pdf2png-cn
```

> 本包尚未发布到 npm 时，可以先从本地目录安装：`npm install /path/to/pdf2png`（或在该目录执行 `npm link`）。

## 命令行

```bash
pdf2png 试卷.pdf
# ✔ 试卷.pdf → 4 张（dpi=200, png）→ /path/to

pdf2png 试卷.pdf --dpi 300 --format jpg --quality 95 --out ./images
pdf2png ./pdfs --recursive --out ./pngs
pdf2png a.pdf b.pdf --pages 1,3-5 --json
```

### 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `-d, --dir` | — | 把输入都当作目录（兼容旧脚本；目录本来就会自动扫描） |
| `-r, --recursive` | 关 | 递归扫描子目录 |
| `--dpi <n>` | 200 | 渲染 DPI，18–1200 |
| `-o, --out <目录>` | PDF 同目录 | 输出目录，不存在会自动创建；别名 `--out-dir` |
| `-e, --ext <png\|jpg>` | png | 输出格式；`--format` 是它的新名字 |
| `--quality <n>` | 90 | JPEG 质量 1–100 |
| `-p, --pages <范围>` | 全部 | 如 `1-3,5`、`2-`、`-3`、`all` |
| `--prefix <名称>` | PDF 文件名 | 输出前缀；批量转换时不可用 |
| `--min-digits <n>` | 2 | 页码最小位数；总页数更多时自动加宽 |
| `--skip-existing` | 关 | 跳过已存在的图片 |
| `--password <密码>` | — | 加密 PDF 的密码 |
| `--json` | 关 | 输出机器可读的 JSON |
| `--debug` | 关 | 额外打印每张图的路径与像素尺寸 |
| `--quiet` | 关 | 只打印错误和最终汇总 |
| `-h, --help` | — | 帮助 |
| `-v, --version` | — | 版本 |

退出码：`0` 全部成功，`1` 有文件失败，`2` 参数或用法错误。

### 输出命名

```
<文件名>_[01].png
<文件名>_[02].png
...
```

补零位数取 `max(--min-digits, 总页数位数)`。例如 4 页 → `_[01]`…`_[04]`；120 页 → `_[001]`…`_[120]`。只渲染第 5 页时，名字仍是 `<文件名>_[05].png`。JPEG 的扩展名是 `.jpg`。

## Node.js API

包根（`.`）是 DSH 插件入口；库 API 在 `pdf2png-cn/core`，避免导入插件层。

```js
import { convert, convertMany, parsePages } from 'pdf2png-cn/core';

// 单个 PDF
const result = await convert('试卷.pdf', {
  dpi: 300,
  format: 'png',       // 'png' | 'jpeg'
  pages: '1-3,5',      // 可选
  outDir: './images',  // 可选，默认 PDF 同目录
  prefix: 'page',      // 可选
  minDigits: 2,
  overwrite: true,     // false = 跳过已存在
  password: 'secret',  // 加密 PDF 可选
});

console.log(result.files);       // 输出图片绝对路径数组
console.log(result.images[0]);   // { path, page, width, height, bytes }
console.log(result.totalPages);  // PDF 总页数
```

```js
// 批量：目录、多个文件；单个失败不会中断
const summary = await convertMany(['./pdfs', 'a.pdf'], {
  dpi: 200,
  recursive: true,
  outDir: './images',
  overwrite: false,
});

console.log(summary.ok, summary.failed, summary.totalImages);
for (const error of summary.errors) console.log(error.pdfPath, error.message);
```

```js
// 工具函数
import { collectInputs, parsePages, normalizeFormat } from 'pdf2png-cn/core';

collectInputs('./pdfs', { recursive: true }); // → 绝对路径数组
parsePages('1-3,5', 10);                      // → [1,2,3,5]
normalizeFormat('jpg');                       // → 'jpeg'
```

CommonJS 下包根只提供异步封装（核心是 ESM + WASM）：

```js
const { convert } = require('pdf2png-cn');
const result = await convert('a.pdf', { dpi: 200 });
```

## DSH 插件

安装后 DSH 会注册工具 **`pdf2png_convert`**：在对话里说「把这份 PDF 转成图片」「PDF 渲染成 PNG 给我 OCR」即可被调用。

把包加入某个 profile（以 `~/.dsh/profiles/web` 为例，做法同 `md2pdf-cn`）：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": {
    "profile": {
      "bundles": ["pdf2png-cn"]
    }
  },
  "dependencies": {
    "pdf2png-cn": "1.0.0"
  }
}
```

`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由它插入插件配置行。插件显示名与说明来自 `locale/zh.json`、`locale/en.json`，图标来自 `icon.svg`。

### 工具参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `input` | string | 必填 | PDF 文件或目录；相对路径按会话工作目录解析 |
| `dpi` | integer | 200 | 18–1200 |
| `format` | string | `png` | `png` / `jpeg` / `jpg` |
| `quality` | integer | 90 | JPEG 质量 1–100 |
| `out_dir` | string | PDF 同目录 | 相对路径按会话工作目录解析 |
| `prefix` | string | PDF 文件名 | 批量时不可用 |
| `pages` | string | 全部 | `1-3,5` / `2-` / `-3` |
| `min_digits` | integer | 2 | 1–6 |
| `skip_existing` | boolean | false | 跳过已存在图片 |
| `overwrite` | boolean | true | 是否覆盖；与 `skip_existing` 冲突时以跳过为准 |
| `recursive` | boolean | false | `input` 为目录时递归 |
| `password` | string | — | 加密 PDF 密码 |

工具返回一段文本：成功数量、每个 PDF 的图片路径与像素尺寸、输出目录、失败列表和提示；超过 30 张时只列前 30 张。全部失败才会报错。

插件配置可设默认参数，例如在 `cordis.patch.yml` 的配置行下：

```yaml
- insert:
    - id: pdf2png-cn
      name: 'pdf2png-cn'
      config:
        defaults:
          dpi: 300
          format: jpg
          out_dir: ./png
```

## 与旧版 `pdf2png.py` 的差异

相同：逐页渲染、`<文件名>_[NN].png` 命名、`--dpi` / `--out` / `--dir`、目录扫描、逐文件汇总与退出码。

新增：`--format` / `--quality` / `--pages` / `--prefix` / `--min-digits` / `--skip-existing` / `--password` / `--recursive` / `--json`、库 API、DSH 工具。

不同：渲染由 MuPDF WASM 完成，不再依赖本机 Python/PyMuPDF；`--ext` 保留为 `--format` 的别名；JPEG 扩展名为 `.jpg`。

## 限制

- 只做栅格化，不抽取文字或表格；需要文字请继续接 OCR。
- 高 DPI / 超大页面占内存；OCR 建议 150–300 dpi。
- `mupdf` 的 WASM 约 14 MB，安装包体积主要来自它。
- 加密 PDF 仅支持密码打开。
- 输出已存在时默认覆盖；批处理建议加 `--skip-existing`。

更细的实现说明与边界见 [docs/DETAIL.md](docs/DETAIL.md)。

## 开发

```bash
npm install
npm test                 # 核心 + CLI + 插件测试
node test/run.mjs        # 只跑核心/CLI
node test/plugin.test.mjs
npm run demo             # 生成测试 PDF 并渲染
```

测试 PDF 由 `test/make-fixture.mjs` 现场生成，不提交二进制样本。

## License

[MIT](LICENSE) © 2026 The pdf2png-cn Authors
