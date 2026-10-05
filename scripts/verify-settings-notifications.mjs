import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const read = (filePath) => readFileSync(path.join(rootDir, filePath), 'utf8');

const settings = read('src/components/SettingsPanel.tsx');
const memorySettings = read('src/components/settings/UserInformationSettings.tsx');
const styles = read('src/styles/variables.css');

assert.match(settings, /if \(!feedback && !error\) return undefined;/, '成功与失败提示都应进入自动关闭计时');
assert.match(settings, /setTimeout\([\s\S]*?setFeedback\(null\);[\s\S]*?setError\(null\);[\s\S]*?2_400/, '设置通知应在短暂展示后统一关闭');
assert.match(settings, /<UserInformationSettings setFeedback=\{setFeedback\} setError=\{setError\}/, '长期记忆提示应上报设置页通知层');
assert.match(settings, /<ModelHubCategoryPanel[\s\S]*?setFeedback=\{setFeedback\} setError=\{setError\}/, '模型中枢提示应上报设置页通知层');
assert.doesNotMatch(settings, /webSearchTestResult/, '联网搜索测试结果不应再在内容区渲染 Alert');
assert.match(settings, /if \(result\.ok\) setFeedback\(result\.message\);[\s\S]*?else setError\(result\.message\);/, '联网搜索测试结果应进入统一通知层');
assert.doesNotMatch(memorySettings, /<Alert\b/, '长期记忆不应再在内容区渲染反馈 Alert');
assert.match(styles, /\.settings-notification \{[\s\S]*?position: absolute;[\s\S]*?top: 88px;[\s\S]*?right: 28px;/, '设置通知应固定在设置区域右上角');

console.log('verify-settings-notifications: unified top-right auto-dismiss notifications passed');
