# Chunking v2 阶段 0 夹具

这些夹具用于锁定父子切块开发前的输入形态和预期边界，不直接接入当前 legacy `run_structure_chunks_stage()`。

## 使用约定

- `manifest.json` 是夹具目录的唯一目录清单；后续测试从 manifest 读取文件，不在测试代码里重复写路径。
- 文本夹具使用 UTF-8，换行语义以 LF 为准；真实输入仍由 `canonicalizeText()` 负责统一。
- `expectedAssertions` 描述未来 v2 引擎必须验证的业务事实，不是阶段 0 对旧引擎的断言。
- `page-and-noise.jsonl` 是结构化 SourceBlock 输入样例，字段尽量贴近 parse/lines/signals/tree 传递的 `blockId/page/sourceRef/sectionPath`。
- 任何新增夹具都必须同步更新 `manifest.json`，并说明它覆盖的策略、边界或失败语义。

## 覆盖范围

| 夹具 | 主要用途 |
| --- | --- |
| `structure-sections.md` | 相邻章节聚合、同名非连续章节、长章节 part、前言和未归属正文 |
| `no-valid-headings.md` | 没有真实标题时 STRUCTURE → 大窗口 RECURSIVE 的降级输入 |
| `recursive-boundaries.md` | 空行、普通换行、句末标点和固定窗口的递归边界优先级 |
| `overlap-boundaries.md` | 自然边界 overlap、硬字符后缀、尾块回并及章节边界隔离 |
| `regex-and-markup.md` | 正则边界、表格、列表、代码片段和正文守恒 |
| `ocr-low-quality.txt` | OCR 噪声、低质量推荐和不应误认的伪标题 |
| `page-and-noise.jsonl` | 页码覆盖率、NOISE 过滤、sourceRef 和 sectionPath 继承 |

阶段 0 只建立可复用输入资产和基线，不改变生产策略、配置契约或 Worker 协议。
