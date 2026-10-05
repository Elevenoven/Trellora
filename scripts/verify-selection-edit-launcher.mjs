import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const overlay = read('src', 'components', 'SelectionActionOverlay.tsx');
const launcher = read('src', 'components', 'selection-edit', 'SelectionEditLauncher.tsx');
const suggestion = read('src', 'components', 'selection-edit', 'SelectionEditSuggestion.tsx');
const session = read('src', 'editor', 'selectionEdit.ts');
const declarations = read('src', 'electron.d.ts');
const theme = read('src', 'styles', 'theme.css');
const packageJson = read('package.json');

assert.match(launcher, /from '@mantine\/core'/, '启动器必须使用 Mantine 组件。');
assert.match(launcher, /<Popover/, '宽屏启动器必须锚定选区 Popover。');
assert.match(launcher, /<Modal/, '窄窗口启动器必须降级为 Modal。');
assert.match(launcher, /<SimpleGrid/, '动作入口必须保留紧凑双列网格。');
assert.match(launcher, /<Select/, '上下文范围必须使用 Mantine Select。');
assert.match(launcher, /上下文收据/, '启动器必须显示上下文收据。');
assert.match(launcher, /当前笔记（受控原文读取）/, 'SE-4 当前笔记范围必须明确为受控原文读取。');
assert.match(launcher, /扩展来源（请使用扩写工作区）/, '扩展来源必须指向已接入的证据工作区。');
assert.match(launcher, /trapFocus=\{false\}/, '选区启动器不能因强制焦点陷阱丢失编辑器选区。');

assert.match(suggestion, /from '@mantine\/core'/, '建议预览必须使用 Mantine 组件。');
assert.match(suggestion, /<Popover/, '宽屏建议预览必须使用 Mantine Popover。');
assert.match(suggestion, /<Modal/, '窄窗口建议预览必须使用 Mantine Modal。');
assert.match(suggestion, /原文/, '建议预览必须保留原文对照。');
assert.match(suggestion, /替换选区/, '建议预览必须保留用户确认替换。');
assert.match(suggestion, /Tooltip label=\{applyDisabledMessage\} withArrow withinPortal zIndex=\{1600\} position="top"/,
  '禁用操作的原因提示必须显示在建议浮层之上，并优先向上展开。');

assert.match(session, /interface SelectionEditLauncherSession/, 'SE-1 必须有统一的 renderer 启动会话。');
assert.match(session, /contextScope: 'auto'/, '新会话默认必须走统一自动上下文范围。');
assert.match(declarations, /SelectionEditAction/, 'Renderer 类型出口必须公开统一动作合同。');
assert.match(declarations, /SelectionEditContextScope/, 'Renderer 类型出口必须公开上下文范围合同。');

assert.match(overlay, /SelectionEditLauncher/, '右键 AI 编辑必须挂载 Mantine 启动器。');
assert.match(overlay, /SelectionEditSuggestion/, '普通编辑建议必须挂载 Mantine 预览。');
assert.match(overlay, /createSelectionEditLauncherSession/, '右键入口必须创建统一启动会话。');
assert.match(overlay, /const snapshot = selectionContextMenu\?\.snapshot/, '跨段落选区也必须能进入 AI 编辑。');
assert.doesNotMatch(overlay, /跨段落选区请使用扩写优化/, '跨段落不能再被普通 AI 编辑入口提前拒绝。');
assert.match(overlay, /MAX_SELECTION_EDIT_WORDS/, '右键菜单只能按公开的 1,000 词上限限制 AI 编辑。');
assert.match(overlay, /session\.contextScope === 'nearby'/, '兼容执行器只能在用户选择附近范围时携带同段上下文。');
assert.match(overlay, /startSelectionEdit/, 'SE-7 普通编辑必须通过统一 IPC 执行。');
assert.match(overlay, /currentPath,\s*contextScope: session\.contextScope/, '普通入口必须把当前笔记定位与范围交给主进程统一协调。');
assert.match(overlay, /onOpenEvidenceWorkspace/, '扩写入口必须能转到现有证据工作区。');
assert.doesNotMatch(overlay, /selection-ai-panel|selection-ai-context/, '原生 AI 编辑浮层与 400 字复选框必须移除。');
assert.doesNotMatch(theme, /selection-ai-/, '已迁移的 AI 浮层样式不得残留在主题 CSS。');
assert.match(packageJson, /"verify:selection-edit-launcher": "node scripts\/verify-selection-edit-launcher\.mjs"/, 'package.json 必须登记 SE-1 启动器验证。');

console.log('Selection edit SE-1 launcher verification passed');
