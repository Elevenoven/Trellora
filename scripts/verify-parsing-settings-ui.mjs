import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const read = (filePath) => readFileSync(path.join(rootDir, filePath), 'utf8');

const settings = read('src/components/SettingsPanel.tsx');
const app = read('src/App.tsx');
const parsingConfig = read('electron/parsingConfig.ts');
const main = read('electron/main.ts');

assert.match(settings, /SettingsSection = .*'parsing'/, 'settings must expose a dedicated parsing section');
assert.match(settings, /label: '文档解析', group: '文档处理'/, 'parsing must be a standalone navigation item');
assert.match(settings, /getParsingConfig\(\)\.then\(setDraftParsing\)/, 'parsing settings must load from the main process');
assert.match(settings, /saveParsingConfig\(\{/, 'MinerU settings must save through preload IPC');
assert.match(settings, /Mammoth[\s\S]*本机处理 · 无需 API/, 'Mammoth suitability guidance must be visible');
assert.match(settings, /旧 DOC、PPT\/PPTX、XLS\/XLSX 与 EPUB 暂不支持/u, 'unsupported binary formats must be explicit');
assert.match(settings, /MinerU[\s\S]*云端增强 · 需要 API Key/, 'MinerU suitability guidance must be visible');
assert.match(settings, /扫描 PDF[\s\S]*表格 \/ 公式[\s\S]*多栏 \/ 图文混排/, 'complex PDF guidance must be explicit');
assert.match(settings, /留空不会覆盖已保存密钥/, 'saved MinerU keys must never be echoed back into the form');

assert.match(app, /onOpenParsingSettings=\{\(\) => void handleOpenSettings\('parsing'\)\}/, 'pipeline actions must open the parsing section');
assert.match(parsingConfig, /safeStorage\.encryptString/, 'MinerU keys must use Electron safeStorage');
assert.match(parsingConfig, /\['http:', 'https:'\]/, 'the main process must reject unsafe endpoint schemes');
assert.match(main, /配置变更后重新入队失败/, 'saving parsing settings must wake waiting pipeline tasks');

console.log('verify-parsing-settings-ui: dedicated menu, engine guidance, secure MinerU config, and pipeline handoff passed');
