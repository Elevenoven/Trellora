import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trellora-language-'));
try {
  const outFile = path.join(temporary, 'language.mjs');
  await build({ entryPoints: ['src/i18n/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: outFile, logLevel: 'silent' });
  const { setAppLanguage, getAppLanguage, t, localizeOptions } = await import(pathToFileURL(outFile).href);
  const messagesFile = path.join(temporary, 'messages.mjs');
  await build({ entryPoints: ['src/i18n/en.ts'], bundle: true, platform: 'node', format: 'esm', outfile: messagesFile, logLevel: 'silent' });
  const { english } = await import(pathToFileURL(messagesFile).href);
  const placeholders = text => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
  for (const [source, translated] of Object.entries(english)) {
    assert.deepEqual(placeholders(translated), placeholders(source), `translation must preserve placeholders: ${source}`);
  }
  globalThis.document = { documentElement: { lang: '' } };
  assert.equal(getAppLanguage(), 'zh-CN');
  assert.equal(t('设置'), '设置');
  setAppLanguage('en-US');
  assert.equal(document.documentElement.lang, 'en-US');
  assert.equal(t('设置'), 'Settings');
  assert.equal(t('已导入技能“{0}”，附加文件 {1} 个。', { 0: '中文技能', 1: 3 }), 'Imported “中文技能” with 3 additional files.');
  assert.equal(t('未知的服务端诊断'), '未知的服务端诊断');
  assert.equal(t('constructor'), 'constructor', 'prototype properties must not become translations');
  const original = [{ value: 'profile', label: '画像', metadata: '原始值' }];
  assert.deepEqual(localizeOptions(original), [{ value: 'profile', label: 'Profile', metadata: '原始值' }]);
  assert.equal(original[0].label, '画像', 'translation must not mutate option data');
  setAppLanguage('zh-CN');
  assert.equal(t('语言设置已保存。'), '语言设置已保存。');
  assert.equal(t('已导入技能“{0}”，附加文件 {1} 个。', { 0: '中文技能', 1: 3 }), '已导入技能“中文技能”，附加文件 3 个。');
  setAppLanguage('unsupported');
  assert.equal(getAppLanguage(), 'zh-CN');
  console.log('Language verified: Chinese default, English translations, interpolation, unknown text, original data, and unsupported-language fallback.');
} finally {
  delete globalThis.document;
  await fs.rm(temporary, { recursive: true, force: true });
}
