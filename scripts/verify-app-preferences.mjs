import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outFile = process.env.MENGHAN_APP_PREFERENCES_PREBUILT
  ? path.resolve(process.env.MENGHAN_APP_PREFERENCES_PREBUILT)
  : path.join(rootDir, '.package-staging', 'verify-app-preferences', 'appPreferences.mjs');
if (!process.env.MENGHAN_APP_PREFERENCES_PREBUILT) {
  await build({ entryPoints: [path.join(rootDir, 'electron', 'appPreferences.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'esm' });
}
const { defaultAppPreferences, getAppPreferences, normalizeAppPreferences, saveAppPreferences } = await import(pathToFileURL(outFile).href);

const values = new Map();
const store = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
assert.deepEqual(getAppPreferences(store), defaultAppPreferences);
assert.equal(defaultAppPreferences.assistantPlanMode, 'current-note');
assert.equal(defaultAppPreferences.adaptiveContextMode, 'observe');
assert.equal(defaultAppPreferences.externalLinkOpenMode, 'in-app');
assert.equal(defaultAppPreferences.lightColorScheme, 'green');
assert.equal(normalizeAppPreferences({ theme: 'dark' }).lightColorScheme, 'green');
assert.equal(normalizeAppPreferences({ lightColorScheme: 'neon' }).lightColorScheme, 'green');

const saved = saveAppPreferences(store, {
  theme: 'dark',
  language: 'en-US',
  density: 'compact',
  startupBehavior: 'last-note',
  externalLinkOpenMode: 'system-default',
  backupRetention: 12,
  defaultEditorMode: 'preview',
  autosaveDelayMs: 2_000,
  previewPreference: 'source',
  assistantPlanMode: 'current-note',
  adaptiveContextMode: 'enforce',
  rightPanelWidth: 420,
  leftSidebarWidth: 360,
  lastOpenedNote: 'D:\\Notes\\Deep.md',
});
assert.equal(saved.schemaVersion, 1);
assert.equal(saved.language, 'en-US');
assert.equal(saved.backupRetention, 3);
assert.equal(saved.lastOpenedNote, 'D:\\Notes\\Deep.md');
assert.equal(saved.rightPanelWidth, 420);
assert.equal(saved.assistantPlanMode, 'current-note');
assert.equal(saved.adaptiveContextMode, 'observe');
assert.equal(saved.externalLinkOpenMode, 'system-default');
assert.equal(saved.leftSidebarWidth, 360);
assert.deepEqual(getAppPreferences(store), saved);

for (const lightColorScheme of ['green', 'blue', 'orange', 'gray', 'pink']) {
  assert.deepEqual(saveAppPreferences(store, { lightColorScheme }), { ...saved, lightColorScheme });
  assert.equal(getAppPreferences(store).lightColorScheme, lightColorScheme);
}
saveAppPreferences(store, { lightColorScheme: 'green' });

const malformed = normalizeAppPreferences({ theme: 'neon', backupRetention: 999, autosaveDelayMs: -1, language: 'fr-FR' });
assert.equal(malformed.theme, 'system');
assert.equal(malformed.backupRetention, 3);
assert.equal(normalizeAppPreferences({ backupRetention: 1 }).backupRetention, 3);
assert.equal(normalizeAppPreferences({ backupRetention: 20 }).backupRetention, 3);
assert.equal(malformed.autosaveDelayMs, 250);
assert.equal(malformed.language, 'zh-CN');
assert.equal(normalizeAppPreferences({ language: 'en-US' }).language, 'en-US');
assert.equal(normalizeAppPreferences({ language: 'zh-CN' }).language, 'zh-CN');
assert.equal(normalizeAppPreferences({}).language, 'zh-CN');
assert.equal(saveAppPreferences(store, { language: 'zh-CN' }).language, 'zh-CN');
saveAppPreferences(store, { language: 'en-US' });
assert.equal(normalizeAppPreferences({ assistantPlanMode: 'unsupported' }).assistantPlanMode, 'current-note');
assert.equal(normalizeAppPreferences({ assistantPlanMode: 'off', adaptiveContextMode: 'enforce' }).adaptiveContextMode, 'observe');
assert.equal(normalizeAppPreferences({ assistantPlanMode: 'library-beta', adaptiveContextMode: 'enforce' }).assistantPlanMode, 'current-note');
assert.equal(normalizeAppPreferences({ externalLinkOpenMode: 'unsupported' }).externalLinkOpenMode, 'in-app');
assert.equal(normalizeAppPreferences({ rightPanelWidth: 100 }).rightPanelWidth, 260);
assert.equal(normalizeAppPreferences({ rightPanelWidth: 900 }).rightPanelWidth, 900);
assert.equal(normalizeAppPreferences({ leftSidebarWidth: 100 }).leftSidebarWidth, 200);
assert.equal(normalizeAppPreferences({ leftSidebarWidth: 900 }).leftSidebarWidth, 520);
await assert.rejects(async () => saveAppPreferences(store, null), /格式无效/);

// 旧用户和新用户共用发行默认；迁移落盘仅执行一次，个人偏好和其他配置不受影响。
const legacyValues = new Map([
  ['appPreferences', {
    ...saved,
    assistantPlanMode: 'library-beta',
    adaptiveContextMode: 'enforce',
    assistantContextRuntimeMode: 'enforce',
    assistantContextRuntimeChatMode: 'off',
    assistantContextRuntimeKnowledgeBaseMode: 'observe',
    assistantContextRuntimeCurrentNoteDirectMode: 'enforce',
    assistantContextRuntimeCurrentNoteReactMode: 'off',
    assistantMemoryProjectionMode: 'canonical',
    assistantMemoryProjectionChatMode: 'legacy',
    assistantMemoryProjectionKnowledgeBaseMode: 'canonical',
    assistantMemoryProjectionCurrentNoteDirectMode: 'legacy',
    assistantMemoryProjectionCurrentNoteReactMode: 'canonical',
  }],
  ['unrelated-model-settings', { model: 'preserve-existing-model' }],
]);
let migrationWrites = 0;
const legacyStore = {
  get: (key) => legacyValues.get(key),
  set: (key, value) => { migrationWrites += 1; legacyValues.set(key, value); },
};
const migrated = getAppPreferences(legacyStore);
assert.deepEqual(migrated, saved);
assert.deepEqual(legacyValues.get('appPreferences'), saved);
assert.equal(migrationWrites, 1);
assert.deepEqual(getAppPreferences(legacyStore), saved);
assert.equal(migrationWrites, 1, '重复读取不得重复落盘');
assert.deepEqual(legacyValues.get('unrelated-model-settings'), { model: 'preserve-existing-model' });
assert.deepEqual(getAppPreferences(null), defaultAppPreferences);

const staleSave = saveAppPreferences(legacyStore, {
  theme: 'light',
  assistantPlanMode: 'off',
  adaptiveContextMode: 'enforce',
  assistantContextRuntimeMode: 'enforce',
  assistantContextRuntimeChatMode: 'off',
  assistantMemoryProjectionMode: 'canonical',
  assistantMemoryProjectionCurrentNoteReactMode: 'legacy',
});
assert.deepEqual(staleSave, { ...saved, theme: 'light' }, '旧客户端的保存请求不能恢复工程开关');

// Old settings, strict numeric inputs and independent successful patches retain their meaning.
const editorLegacy = normalizeAppPreferences({ defaultEditorMode: 'source' });
assert.equal(editorLegacy.editorFontSizePx, 16);
assert.equal(editorLegacy.editorMarkdownAutoConvert, true);
assert.equal(editorLegacy.editorFocusModeEnabled, false);
const invalidEditor = normalizeAppPreferences({ editorFontSizePx: '', editorLineHeight: NaN, defaultEditorZoom: Infinity, editorSelectionToolbarEnabled: 'false', editorContentWidth: { value: 'wide' } });
assert.equal(invalidEditor.editorFontSizePx, 16);
assert.equal(invalidEditor.editorLineHeight, 1.7);
assert.equal(invalidEditor.defaultEditorZoom, 1);
assert.equal(invalidEditor.editorSelectionToolbarEnabled, true);
assert.equal(invalidEditor.editorContentWidth, 'standard');
assert.equal(normalizeAppPreferences({ editorFontSizePx: 999, defaultEditorZoom: 1.27 }).editorFontSizePx, 24);
assert.equal(normalizeAppPreferences({ defaultEditorZoom: 1.27 }).defaultEditorZoom, 1.25);
saveAppPreferences(store, { editorFontSizePx: 20 });
saveAppPreferences(store, { editorPasteMode: 'plain-text' });
assert.equal(getAppPreferences(store).editorFontSizePx, 20);
assert.equal(getAppPreferences(store).editorPasteMode, 'plain-text');
console.log('App preferences verification passed');
