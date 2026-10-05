# GitHub 展示资源 / GitHub showcase assets

本目录保存 README 使用的真实界面截图；与 `docs/prototypes/` 中的设计原型区分。图片包含 **2026-10-05** 从当前源码构建的 Electron 拍摄的 **1440 × 960** 演示截图，以及用户提供的三张实际使用截图。所有图片按原图收录，没有进行图片合成、界面文字替换或 AI 生图。

These are actual application screenshots, separate from design prototypes. They include **1440 × 960** Electron demo captures from current source on **2026-10-05**, plus three actual-use screenshots supplied by the user. Images are preserved as supplied or captured, with no composited UI, substituted text, or AI-generated imagery.

## 文件 / Files

| 截图 | 内容 / Content |
| --- | --- |
| [notes-zh-light.png](screenshots/notes-zh-light.png) | 中文笔记编辑 / Chinese note editing |
| [notes-en-dark.png](screenshots/notes-en-dark.png) | 英文深色笔记界面 / English dark notes |
| [notes-assistant-zh-light.png](screenshots/notes-assistant-zh-light.png) | 用户提供：笔记与当前笔记 AI 助手 / User-provided: notes and current-note AI |
| [assistant-zh-light.png](screenshots/assistant-zh-light.png) | 用户提供：知识库回答、文档引用与记忆来源 / User-provided: knowledge-base answer, citations, and memory references |
| [assistant-en-dark.png](screenshots/assistant-en-dark.png) | 英文深色助手入口 / English dark assistant |
| [materials-zh-light.png](screenshots/materials-zh-light.png) | 资料列表与原文预览 / Materials and preview |
| [wiki-zh-light.png](screenshots/wiki-zh-light.png) | 用户提供：文档目录、章节画布与 AI 分析面板 / User-provided: outline, chapter canvas, and AI analysis panel |
| [map-zh-light.png](screenshots/map-zh-light.png) | 图谱未配置时的实际状态 / Actual state before graph projection |
| [external-document-zh-light.png](screenshots/external-document-zh-light.png) | 独立 Markdown 文件源码编辑 / Standalone source editing |
| [libraries-zh-light.png](screenshots/libraries-zh-light.png) | 笔记库管理 / Library management |
| [settings-zh-light.png](screenshots/settings-zh-light.png) | 中文通用设置与十个子菜单 / Chinese settings |
| [settings-en-dark.png](screenshots/settings-en-dark.png) | 英文深色设置 / English dark settings |

## 拍摄范围 / Capture scope

自行拍摄的演示截图使用独立临时 `userData`、笔记库和工作区，示例数据为虚构的“星桥”项目。英文深色助手图展示未配置模型的实际入口；地图截图展示尚未生成图谱的状态。该拍摄过程没有调用远程模型、Embedding、MinerU 或图谱增强，临时拍摄环境已清理；其中出现的临时路径仅为演示路径。

The self-captured demo used isolated temporary user data and fictional project content. The English dark Assistant image shows its unconfigured entry; Map shows the state before graph enrichment. This capture session made no remote model, embedding, MinerU, or graph enrichment calls. Temporary environments were removed; any temporary paths in those images are demonstration paths.

用户提供的三张截图展示知识库问答的回答、文档引用和记忆来源，笔记与当前笔记 AI 助手，以及 Wiki 的章节浏览和 AI 分析入口。它们按原图复制，尺寸分别为 **1919 × 1141**、**1919 × 1129**、**1919 × 1137**；拍摄时间和版本不从演示环境继承。截图中的笔记正文属于用户文档内容，不是 Trellora 内置工具列表。

The three user-provided images show a knowledge-base answer with citations and memory references, notes with current-note AI, and Wiki chapter browsing with AI analysis controls. They are copied unchanged at **1919 × 1141**, **1919 × 1129**, and **1919 × 1137**, respectively. Their capture dates and versions are not inferred from the demo session. Note body text is user-authored document content, not a list of Trellora's built-in tools.

此说明与 [capture.json](screenshots/capture.json) 分别记录两组图片的来源、尺寸及用户原图的 SHA-256，不替代功能或发行包验收。

This page and [capture.json](screenshots/capture.json) distinguish the two image groups and record dimensions and SHA-256 hashes for the supplied originals. They document provenance, not full feature or release acceptance.

## README 编排参考 / Presentation references

参考了 [Logseq README](https://github.com/logseq/logseq/blob/master/README.md)、[Memos README](https://github.com/usememos/memos/blob/main/README.md) 和 [Flowise README](https://github.com/FlowiseAI/Flowise/blob/main/README.md) 的产品介绍、目录、截图、开发入口及文档导航形式。正文、功能描述和图片均针对 Trellora 编写，没有复制这些项目的品牌、功能承诺或许可证。

The layout follows common product overview, navigation, screenshots, setup, and developer documentation patterns illustrated by those projects. Trellora descriptions and screenshots are original and do not import their branding, feature claims, or licenses.

更新截图时应从真实应用重新拍摄，保持演示数据、语言和主题可识别，并同时更新两份 README 中的链接及此处的来源记录。
