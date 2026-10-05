/** Verification scripts also use the production versioned API; the old blind writer is retired. */
export async function installFixtureNoteSave(session) {
  await session.evaluate(`globalThis.__saveNoteFixture = async (path, content) => {
    const snapshot = await window.electronAPI.openNoteEditSession(path);
    try {
      const result = await window.electronAPI.saveNote({ editSessionId: snapshot.editSessionId, requestId: crypto.randomUUID(), editRevision: 1, expectedDiskHash: snapshot.version.diskHash, content });
      if (result.status !== 'committed' && result.status !== 'unchanged') throw new Error(result.message);
      await window.electronAPI.retryNoteIndex(snapshot.editSessionId);
      return true;
    } finally { await window.electronAPI.closeNoteEditSession(snapshot.editSessionId); }
  }`);
}
