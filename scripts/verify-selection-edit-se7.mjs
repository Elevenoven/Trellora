import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const read = (relativePath) => fs.readFile(path.join(rootDir, relativePath), 'utf8');
const settingsBundle = path.join(rootDir, 'scripts', '.verify-selection-edit-se7-settings.cjs');
const ipcBundle = path.join(rootDir, 'scripts', '.verify-selection-edit-se7-ipc.cjs');

const [main, preload, declarations, overlay, launcher, settings, types, editorSession, ipcSource] = await Promise.all([
  read('electron/main.ts'),
  read('electron/preload.ts'),
  read('src/electron.d.ts'),
  read('src/components/SelectionActionOverlay.tsx'),
  read('src/components/selection-edit/SelectionEditLauncher.tsx'),
  read('electron/knowledge/selectionExpansionSettings.ts'),
  read('electron/knowledge/selectionExpansionTypes.ts'),
  read('src/editor/selectionEdit.ts'),
  read('electron/knowledge/selectionEditIpc.ts'),
]);

assert.match(main, /ipcMain\.handle\('selection-edit:start'/, '主进程必须提供统一选区编辑入口。');
assert.match(main, /ipcMain\.handle\('selection-edit:cancel'/, '主进程必须提供统一选区编辑取消入口。');
assert.match(main, /resolveSelectionEditRuntimeMode\(\) === 'legacy'/, '旧链必须仅通过版本开关回退。');
assert.match(ipcSource, /MENGHAN_SELECTION_EDIT_MODE/, '回退开关必须由统一传输层读取。');
assert.match(main, /runSelectionEditCoordinator/, '统一入口必须直接调用统一协调器。');
assert.match(main, /start-selection-transform/, '观察期内旧 IPC 必须保留兼容入口。');
assert.match(preload, /startSelectionEdit/, 'Preload 必须暴露统一启动 API。');
assert.match(preload, /cancelSelectionEdit/, 'Preload 必须暴露统一取消 API。');
assert.match(declarations, /startSelectionEdit:/, 'Renderer 类型声明必须包含统一启动 API。');
assert.match(declarations, /cancelSelectionEdit:/, 'Renderer 类型声明必须包含统一取消 API。');
assert.match(overlay, /startSelectionEdit/, '普通选区弹层必须走统一启动 API。');
assert.match(overlay, /cancelSelectionEdit/, '普通选区弹层必须走统一取消 API。');
assert.doesNotMatch(overlay, /startSelectionTransform/, '普通选区弹层不能再直接依赖旧 transform IPC。');
assert.doesNotMatch(overlay, /cancelSelectionTransform/, '普通选区弹层不能再直接依赖旧 transform 取消 IPC。');
assert.match(overlay, /action: 'custom'/, '普通选区弹层必须公开第七个自定义动作。');
assert.match(launcher, /action === 'custom'/, '自定义动作必须有专用要求输入。');
assert.match(editorSession, /unified `selection-edit:\*` IPC/, '启动器状态说明必须反映统一入口。');
assert.match(types, /schemaVersion: 2/, '统一扩写设置必须使用 v2。');
assert.match(settings, /selectionExpansionSettingsSchemaVersion = 2/, '设置迁移必须固定当前版本。');

try {
  await Promise.all([fs.rm(settingsBundle, { force: true }), fs.rm(ipcBundle, { force: true })]);
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionExpansionSettings.ts')],
      outfile: settingsBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
    build({
      entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'selectionEditIpc.ts')],
      outfile: ipcBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    }),
  ]);
  const settingsModule = await import(`${pathToFileURL(settingsBundle).href}?v=${Date.now()}`);
  const ipcModule = await import(`${pathToFileURL(ipcBundle).href}?v=${Date.now()}`);

  const legacySettings = {
    schemaVersion: 1,
    targetLength: { mode: 'characters', characters: 880 },
    style: 'professional',
    audience: 'manager',
    reasoningDepth: 'deep',
    modelProfileId: 'profile-legacy',
    sources: {
      currentNote: false,
      noteLibrary: true,
      materialsLibrary: false,
      web: 'inherit',
    },
    citationMode: 'copy-with-sources',
    customInstruction: '保留产品名的中英文写法',
  };
  const storage = new Map([['selectionExpansionSettings', legacySettings]]);
  let writes = 0;
  const store = {
    get: (key) => storage.get(key),
    set: (key, value) => {
      writes += 1;
      storage.set(key, value);
    },
  };
  const migrated = settingsModule.readSelectionExpansionSettings(store);
  assert.equal(migrated.schemaVersion, 2, '旧设置必须迁移到 v2。');
  assert.deepEqual(migrated.targetLength, legacySettings.targetLength, '旧目标长度不得丢失。');
  assert.equal(migrated.style, legacySettings.style, '旧文风不得丢失。');
  assert.equal(migrated.audience, legacySettings.audience, '旧读者设置不得丢失。');
  assert.equal(migrated.reasoningDepth, legacySettings.reasoningDepth, '旧思考强度不得丢失。');
  assert.equal(migrated.modelProfileId, legacySettings.modelProfileId, '旧模型档案不得丢失。');
  assert.deepEqual(migrated.sources, {
    ...legacySettings.sources,
    personalization: false,
  }, '旧来源设置必须保留，并补齐默认关闭的新来源。');
  assert.equal(migrated.citationMode, legacySettings.citationMode, '旧引用展示设置不得丢失。');
  assert.equal(migrated.customInstruction, legacySettings.customInstruction, '旧自定义要求不得丢失。');
  assert.equal(writes, 1, '第一次读取旧设置必须只写回一次规范化迁移结果。');
  assert.deepEqual(settingsModule.readSelectionExpansionSettings(store), migrated, '迁移后的读取必须稳定。');
  assert.equal(writes, 1, '已迁移设置不得重复写回。');

  const emptyStore = { get: () => undefined, set: () => { throw new Error('默认设置读取不应产生写入。'); } };
  assert.equal(settingsModule.readSelectionExpansionSettings(emptyStore).schemaVersion, 2);

  assert.equal(ipcModule.resolveSelectionEditRuntimeMode(undefined), 'unified', '未设置开关时必须默认统一链。');
  assert.equal(ipcModule.resolveSelectionEditRuntimeMode('legacy'), 'legacy', '必须可显式回退到旧链。');
  assert.equal(ipcModule.resolveSelectionEditRuntimeMode('unexpected'), 'unified', '未知开关不得意外启用旧链。');
  assert.equal(ipcModule.countSelectionEditWords('词频饱和 BM25 2026'), 6, '中文按字计，连续拉丁数字按词计。');
  const request = ipcModule.validateSelectionEditRunRequest({
    requestId: 'selection-se7-0001',
    action: 'custom',
    selectedText: '原始内容',
    currentPath: 'notes/example.md',
    contextScope: 'auto',
    customInstruction: '改为适合周报的正式语气',
  });
  assert.equal(request.customInstruction, '改为适合周报的正式语气');
  assert.doesNotThrow(() => ipcModule.validateSelectionEditRunRequest({
    requestId: 'selection-se7-1000', action: 'polish', selectedText: '字'.repeat(ipcModule.MAX_SELECTION_EDIT_WORDS), contextScope: 'auto',
  }), '刚好 1,000 个中文编辑单位必须可用。');
  assert.throws(() => ipcModule.validateSelectionEditRunRequest({
    requestId: 'selection-se7-1001', action: 'polish', selectedText: '字'.repeat(ipcModule.MAX_SELECTION_EDIT_WORDS + 1), contextScope: 'auto',
  }), /不能超过 1,000 词/u, '超过 1,000 个中文编辑单位才应被入口限制。');
  assert.throws(() => ipcModule.validateSelectionEditRunRequest({
    requestId: 'selection-se7-0002', action: 'polish', selectedText: '原始内容', contextScope: 'auto', instruction: '旧字段',
  }), /不支持的字段/, '统一入口不能接受旧 instruction 字段。');
} finally {
  await Promise.all([fs.rm(settingsBundle, { force: true }), fs.rm(ipcBundle, { force: true })]);
}

console.log('Selection edit SE-7 verification passed');
