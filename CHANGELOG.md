# Changelog

## 1.0.0 — 2026-11-25

首个版本：把原来的 `pdf2png.py` 重做为 npm 包 + CLI + DSH 插件。

### 新增

- 基于 MuPDF 官方 WASM（npm `mupdf`）的逐页渲染，不再依赖 Python / PyMuPDF。
- 命令行 `pdf2png`：支持文件与目录、`--dpi`、`--out`、`--format`（`--ext` 兼容别名）、`--quality`、`--pages`、`--prefix`、`--min-digits`、`--skip-existing`、`--password`、`--recursive`、`--json`、`--debug`、`--quiet`。
- Node.js 库 API（`pdf2png-cn/core`）：`convert()`、`convertMany()`、`collectInputs()`、`parsePages()`、`normalizeFormat()`。
- CommonJS 异步封装（`require('pdf2png-cn')`）。
- DSH 插件工具 `pdf2png_convert`，含中文/英文插件元数据与图标。
- JPEG 输出（`.jpg`，质量可调）、页码范围、加密 PDF、跳过已存在文件。
- 输出命名与旧脚本一致：`<文件名>_[01].png`，编号随总页数自动加宽。
- 测试：核心/CLI/插件共 28 项，测试 PDF 现场生成。

### 兼容

- 保留 `--dir`、`--ext`、`--out` 等旧参数；默认输出位置与文件名不变。
- `--dir` 现在是可选兼容项：目录输入本来就会自动扫描。

### 已知限制

- 仅栅格化，不抽取文字。
- 高 DPI 占内存；WASM 体积约 14 MB。
- 加密 PDF 仅支持密码打开。
