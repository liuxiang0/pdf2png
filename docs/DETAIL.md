# pdf2png-cn — 实现与边界说明

本文件说明包内部如何工作、与旧脚本的兼容点，以及需要提前知道的限制。CLI 与 API 的完整用法见 [README](../README.md)。

## 渲染引擎

- 使用 npm 包 `mupdf`（MuPDF 官方 WebAssembly 构建，约 14 MB），与 Python 的 PyMuPDF 同源，因此中文、公式、图片的渲染结果与旧版 `pdf2png.py` 基本一致。
- Node.js 直接加载 WASM，不需要 Python、Poppler、ImageMagick 或本机编译工具；首次 `import 'pdf2png-cn/core'` 时加载约 14 MB 的 WASM。
- 页面按 CropBox 渲染（与 PyMuPDF 的 `page.rect` 行为一致），颜色空间 DeviceRGB、白色背景、包含注释。

## 输出命名

```
<前缀>_[<页码>].<png|jpg>
```

- 前缀默认取 PDF 文件名（不含扩展名），可用 `prefix` / `--prefix` 覆盖。
- 页码补零位数 = `max(minDigits, 总页数位数)`，默认 `minDigits = 2`。例如 4 页 → `_ [01]`…`_[04]`；120 页 → `_[001]`…`_[120]`。
- 只渲染部分页时，页码仍是 PDF 中的真实页码，例如 `--pages 5` 得到 `_ [05].png`。
- JPEG 的扩展名是 `.jpg`。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `dpi` | 200 | 18–1200；A4 在 200 dpi 下为 1656×2342 |
| `format` | `png` | `png` / `jpeg`（`jpg` 同义） |
| `quality` | 90 | JPEG 质量 1–100 |
| `outDir` | PDF 同目录 | 不存在会自动创建 |
| `prefix` | PDF 文件名 | 不能包含路径分隔符；批量转换时不可用 |
| `pages` | 全部 | `"1-3,5"`、`"2-"`、`"-3"`、`"all"` 或数字数组 |
| `minDigits` | 2 | 1–6 |
| `overwrite` | true | false 时跳过已存在的输出并在结果中列出 |
| `password` | — | 加密 PDF 的密码 |

目录输入默认只扫描第一层；`recursive: true` / `--recursive` 递归子目录。显式文件不去重前会按绝对路径去重，目录中的隐藏项跳过。

## 错误处理

- 参数错误抛出 `Pdf2PngError`；渲染引擎错误会被包成 `渲染失败（文件名）：原因`。
- `convert()` 对单个 PDF 的失败直接抛出；`convertMany()` 不中断其它文件，失败进入 `errors`。
- CLI 退出码：`0` 全部成功、`1` 有文件失败、`2` 参数/用法错误。
- DSH 工具在部分文件失败时仍返回成功结果并在文本末尾列出失败项；全部失败才抛错。

## 已知限制

- 不解析 PDF 内容，只做栅格化；需要文字/表格抽取请另用 OCR 或解析库。
- 超大页面/超高 DPI 会占用较多内存；建议 OCR 用 150–300 dpi，超过 600 dpi 时先确认内存。
- 加密 PDF 只支持密码打开，不支持证书/权限绕过。
- MuPDF WASM 体积约 14 MB；对安装包大小敏感的场景请在打包时排除未用格式（本包未做裁剪）。
- 输出文件已存在时默认覆盖；批量任务建议加 `--skip-existing` 以便断点续跑。

## 与旧版 pdf2png.py 的差异

相同：逐页渲染、`<文件名>_[NN].png` 命名、`--dpi` / `--out` / `--dir`、目录扫描、逐文件成功/失败汇总与退出码。

新增：`--format` / `--quality` / `--pages` / `--prefix` / `--min-digits` / `--skip-existing` / `--password` / `--recursive` / `--json`，以及库 API 和 DSH 工具。

不同：渲染由 MuPDF WASM 完成，不依赖本机 Python 与 PyMuPDF；`--ext` 保留为 `--format` 的兼容别名。JPEG 的扩展名为 `.jpg`（旧脚本只支持 png）。
