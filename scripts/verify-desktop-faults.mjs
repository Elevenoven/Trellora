import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { releasePaths } from './release-paths.mjs';
import { launchNoteTest, waitFor } from './electron-note-test-session.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'trellora-desktop-faults-'));
let session;
try {
  const unpacked = releasePaths().unpacked, copied = path.join(root, 'application');
  await cp(unpacked, copied, { recursive: true, filter: source => source !== path.join(unpacked, 'resources', 'pipeline-runtime') });
  const userData = path.join(root, 'profile'), workspace = path.join(root, 'workspace'), library = path.join(root, 'notes');
  for (const directory of [userData, library, path.join(workspace, 'ConversationMemory')]) await mkdir(directory, { recursive: true });
  const corrupt = path.join(workspace, 'ConversationMemory', 'qa-memory.db'), corruptBytes = Buffer.from('INTENTIONALLY_CORRUPT_MEMORY_SENTINEL');
  await writeFile(corrupt, corruptBytes);
  const note = path.join(library, '原文.md'); await writeFile(note, '# 原文保留\n');
  await writeFile(path.join(userData, 'config.json'), JSON.stringify({ workspacePath: workspace, libraryPath: library, onboarding: { version: 1, status: 'completed' } }));
  session = await launchNoteTest({ userData, executablePath: path.join(copied, 'Trellora.exe') });
  const diagnostics = await session.evaluate('window.electronAPI.getAppDiagnostics()'); assert.equal(diagnostics.workspacePath, workspace);
  const probe = await session.evaluate("window.electronAPI.probeUserCapability({requestId:'missing-runtime',capability:'documentWorker'})");
  const worker = probe.capabilities.find(item => item.id === 'documentWorker'); assert.equal(worker.state, 'unreachable'); assert.match(worker.message, /组件不可用/);
  const imported = await session.evaluate('window.electronAPI.importOnboardingSample()'); assert.equal(imported.length, 2, 'core note writing must remain available');
  assert.equal(await readFile(note, 'utf8'), '# 原文保留\n'); assert.deepEqual(await readFile(corrupt), corruptBytes, 'corrupt memory must not be silently replaced');
  await session.closeWindow(); await waitFor(() => session.child.exitCode !== null, 'fault-injected application normal exit');
  console.log('packaged faults: missing embedded Python with restricted PATH, corrupt QA database retained, normal notes writable, originals unchanged and normal exit passed');
} finally {
  await session?.dispose(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'trellora-desktop-faults-'))); await rm(root, { recursive: true, force: true });
}
