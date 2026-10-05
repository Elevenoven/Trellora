import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const read = (filePath) => readFileSync(path.join(rootDir, filePath), 'utf8');

const settings = read('src/components/SettingsPanel.tsx');
const webSearch = read('electron/websearch/webSearchConfig.ts');
const parsing = read('electron/parsingConfig.ts');
const aiSettings = read('electron/knowledge/aiSettings.ts');
const modelHub = read('electron/knowledge/modelHub.ts');
const app = read('src/App.tsx');

assert.doesNotMatch(settings, /settings-consent-alert/, '设置页不应再渲染远程服务确认勾选项');
assert.doesNotMatch(settings, /需要先确认|待授权/, '设置页不应再要求用户手动确认远程发送');
assert.match(webSearch, /consent:\s*true/, '联网搜索默认应视为已同意');
assert.match(webSearch, /const consent = true;/, '保存联网搜索设置时应固定为已同意');
assert.match(parsing, /cloudParsingConsent:\s*true/, 'PDF 云端解析默认应视为已同意');
assert.match(aiSettings, /remoteContentConsent:\s*true/, '远程模型档案应自动迁移为已同意');
assert.match(modelHub, /remoteConsent:\s*true/, '模型中枢远程调用应默认同意');
assert.match(app, /remoteConsent:\s*true/, '渲染进程初始模型中枢状态应默认同意');

console.log('verify-default-remote-consent: remote consent defaults and hidden confirmation controls passed');
