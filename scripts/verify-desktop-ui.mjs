import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchNoteTest, waitFor } from './electron-note-test-session.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellora-desktop-ui-'));
const output = path.resolve('docs/verification/desktop-ui'); fs.mkdirSync(output, { recursive: true });
const results = []; let session;
try {
  for (const language of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) {
    const profile = path.join(root, `${language}-${theme}`), userData = path.join(profile, 'user-data'), workspace = path.join(profile, 'workspace'); fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: workspace, appPreferences: { language, theme } }));
    session = await launchNoteTest({ mainEntry: path.resolve('dist-electron/main.js'), userData, navigationLabel: language === 'zh-CN' ? '助手' : 'Assistant' });
    assert.equal((await session.evaluate('window.electronAPI.getOnboardingState()')).status, 'pending');
    await waitFor(() => session.evaluate('Boolean(document.querySelector("[data-testid=first-run-guide]"))'), 'menu guide loaded');
    for (const scale of [1, 1.25, 1.5]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width: Math.floor(1280 / scale), height: Math.floor(900 / scale), deviceScaleFactor: scale, mobile: false });
      const label = `${language}-${theme}-${Math.round(scale * 100)}`;
      const guide = await session.evaluate(`(()=>{const guide=document.querySelector('[data-testid="first-run-guide"]');if(!guide)return null;const r=guide.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,bottom:r.bottom,height:innerHeight,text:guide.textContent,scrollable:guide.scrollHeight>guide.clientHeight};})()`);
      assert.ok(guide, label); assert.ok(guide.left >= 0 && guide.right <= guide.width + 1, label); assert.ok(guide.bottom <= guide.height, label);
      if (language === 'en-US') assert.match(guide.text, /Meet your workspace/);
      const screenshot = await session.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, `${label}-guide.png`), Buffer.from(screenshot.data, 'base64'));
      results.push({ language, theme, scale, guideFitsViewport: true, guideScrolls: guide.scrollable });
    }
    await session.evaluate(`window.electronAPI.getOnboardingState().then(state => window.electronAPI.updateOnboardingState({ action: 'defer', expectedRevision: state.revision }))`);
    await waitFor(() => session.evaluate('!document.querySelector("[data-testid=first-run-guide]")'), 'guide paused');
    const settingsLabel = language === 'zh-CN' ? '设置' : 'Settings'; await session.evaluate(`document.querySelector('.app-nav-item[aria-label="${settingsLabel}"]').click()`);
    await waitFor(() => session.evaluate(`Boolean([...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent==='${language === 'zh-CN' ? '工作区与备份' : 'Workspace & backups'}'))`), 'workspace settings');
    await session.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent==='${language === 'zh-CN' ? '工作区与备份' : 'Workspace & backups'}').click()`);
    await waitFor(() => session.evaluate("Boolean(document.querySelector('[data-testid=workspace-backup-settings]') && document.querySelector('[data-testid=workspace-restore-settings]'))"), 'backup and restore UI');
    assert.equal(await session.evaluate("[...document.querySelectorAll('main.main-pane')].filter(element=>getComputedStyle(element).display!=='none').length"), 1, 'Only one cached main view is visible');
    assert.equal(await session.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true, 'Settings do not overflow the viewport');
    const settings = await session.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, `${language}-${theme}-150-settings.png`), Buffer.from(settings.data, 'base64'));
    await session.closeWindow(); await waitFor(() => session.child.exitCode !== null, 'UI fixture normal exit'); await session.dispose(); session = undefined;
    console.log(`desktop UI: ${language} ${theme}, 100/125/150% viewport simulation and backup/restore settings passed`);
  }
  fs.writeFileSync(path.resolve('docs/verification/desktop-ui.json'), JSON.stringify({ checkedAt: new Date().toISOString(), method: 'real Electron CDP, 1280x900 physical viewport simulated at 100/125/150%; not a Windows DPI-setting change', results }, null, 2));
} finally { await session?.dispose(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'trellora-desktop-ui-'))); fs.rmSync(root, { recursive: true, force: true }); }
