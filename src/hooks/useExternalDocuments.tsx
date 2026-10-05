import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import type { DocumentEncoding, DocumentFormat, DocumentSnapshot, DocumentJoinRequest, DocumentJoinResult, DocumentOpenRequest } from '../../shared/documentSession';
import { DocumentSaveController } from '../utils/documentSaveController';
import { t } from '../i18n';

type Choice = { title: string; message: string; options: { value: string; label: string }[]; select?: boolean; resolve: (value: string | null) => void };
interface Options { beforeOpen: () => Promise<boolean>; openLibrary: (library: string, file: string) => Promise<boolean>; showNotes: () => void; blocked: boolean }
/** 打开候选文档成功后再结束旧会话；维护只刷新恢复缓存，不保存原件。 */
export function useExternalDocuments(options: Options) {
  const [, render] = useState(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingBlocked, setEditingBlocked] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<DocumentOpenRequest[]>([]), [queueOpened, setQueueOpened] = useState(false);
  const pendingFilesRef = useRef<DocumentOpenRequest[]>([]), refreshRequestsRef = useRef<() => Promise<DocumentOpenRequest[]>>(async () => []);
  const pendingJoin = useRef<{ request: DocumentJoinRequest; result?: DocumentJoinResult } | null>(null);
  const busyRef = useRef(false), routing = useRef(false), optionsRef = useRef(options), maintained = useRef(false);
  useLayoutEffect(() => { optionsRef.current = options; });
  const [controller] = useState(() => new DocumentSaveController({ updateDraft: request => window.electronAPI.updateDocumentDraft(request), save: request => window.electronAPI.saveDocument(request), saveAs: request => window.electronAPI.saveDocumentAs(request) }, () => render(n => n + 1)));
  const ask = useCallback((title: string, message: string, answers: { value: string; label: string }[], select = false) => new Promise<string | null>(resolve => {
    setSelected(answers[0]?.value ?? null); setChoice({ title, message, options: answers, select, resolve });
  }), []);
  const finishChoice = (value: string | null) => { choice?.resolve(value); setChoice(null); };
  const run = useCallback(async (action: () => Promise<void>, freezeEditor = true) => {
    if (busyRef.current || optionsRef.current.blocked || maintained.current) return;
    busyRef.current = true; setBusy(true); setEditingBlocked(freezeEditor);
    try { await action(); } catch (error) { window.alert(String(error)); }
    finally { busyRef.current = false; setBusy(false); setEditingBlocked(false); await refreshRequestsRef.current(); }
  }, []);
  const save = useCallback(async (mode: 'save' | 'saveAs' = 'save', utf8 = false): Promise<boolean> => {
    const snapshot = controller.snapshot;
    if (!snapshot) return true;
    let override: Partial<DocumentFormat> | undefined = utf8 ? { encoding: 'utf8', bom: 'none' } : undefined;
    if (snapshot.format.lineEnding === 'mixed' && (controller.dirty || mode === 'saveAs')) {
      const eol = await ask(t('选择换行格式'), t('文件包含混合换行。保存修改时请选择统一的换行格式。'), [{ value: 'crlf', label: 'CRLF (Windows)' }, { value: 'lf', label: 'LF' }], true);
      if (!eol) return false; override = { ...override, lineEnding: eol as 'lf' | 'crlf' };
    }
    return controller.save(mode, override);
  }, [controller, ask]);
  const closeReason = useCallback(async (): Promise<'saved' | 'discard' | null> => {
    if (!controller.snapshot) return 'saved';
    await controller.synchronize();
    if (!controller.dirty) return 'saved';
    optionsRef.current.showNotes();
    const answer = await ask(t('文件尚未保存'), controller.snapshot.displayPath, [{ value: 'save', label: t('保存') }, { value: 'discard', label: t('放弃修改') }, { value: 'cancel', label: t('取消') }]);
    if (answer === 'save') { while (controller.dirty) if (!await save()) return null; return 'saved'; }
    return answer === 'discard' ? 'discard' : null;
  }, [controller, ask, save]);
  const finishSession = useCallback(async (reason: 'saved' | 'discard' | 'transferred', transferToken?: string) => {
    if (!controller.snapshot) return;
    await controller.synchronize();
    const result = await window.electronAPI.closeDocument({ documentSessionId: controller.snapshot.documentSessionId, draftRevision: controller.revision, reason, transferToken });
    if (result.recoveryMessage) window.alert(t(result.recoveryMessage));
    controller.reset();
  }, [controller]);
  const prepareTransition = useCallback(async (): Promise<boolean> => {
    if (routing.current || !controller.snapshot) return true;
    if (busyRef.current || optionsRef.current.blocked || maintained.current) return false;
    let ok = false; await run(async () => { const reason = await closeReason(); if (reason) { await finishSession(reason); ok = true; } }); return ok;
  }, [controller, run, closeReason, finishSession]);
  const activateCandidate = async (snapshot: DocumentSnapshot) => {
    if (snapshot.documentSessionId === controller.snapshot?.documentSessionId) { optionsRef.current.showNotes(); return; }
    const reason = await closeReason();
    if (!reason) { await window.electronAPI.closeDocument({ documentSessionId: snapshot.documentSessionId, draftRevision: snapshot.draftRevision, reason: snapshot.persistedRevision < 0 ? 'discard' : 'saved' }); return; }
    await finishSession(reason); controller.open(snapshot); optionsRef.current.showNotes();
  };
  const processRequest = async (id: string) => {
    if (!await optionsRef.current.beforeOpen()) return;
    let result = await window.electronAPI.openDocumentRequest(id);
    while (result.status === 'encoding-required') {
      const encoding = await ask(t('选择文本编码'), result.message, [{ value: 'utf8', label: 'UTF-8' }, { value: 'utf16le', label: 'UTF-16 LE' }, { value: 'utf16be', label: 'UTF-16 BE' }, { value: 'gbk', label: 'GBK' }, { value: 'gb18030', label: 'GB18030' }], true);
      if (!encoding) return; result = await window.electronAPI.openDocumentRequest(id, encoding as DocumentEncoding);
    }
    if (result.status === 'library') {
      const reason = await closeReason(); if (!reason) return;
      routing.current = true;
      try { if (await optionsRef.current.openLibrary(result.libraryPath, result.filePath)) await finishSession(reason); }
      finally { routing.current = false; }
    } else await activateCandidate(result.snapshot);
  };
  const drainRequestsRef = useRef<(id?: string) => Promise<void>>(async () => undefined);
  useLayoutEffect(() => {
    refreshRequestsRef.current = async () => {
      try {
        const requests = await window.electronAPI.listDocumentOpenRequests(); pendingFilesRef.current = requests; setPendingFiles(requests);
        const failures = await window.electronAPI.takeDocumentOpenFailures(); if (failures.length) window.alert(failures.map(failure => `${failure.displayPath}\n${failure.message}`).join('\n\n'));
        return requests;
      } catch { return pendingFilesRef.current; }
    };
    drainRequestsRef.current = async id => {
      const requests = await refreshRequestsRef.current(), request = id ? requests.find(request => request.requestId === id) : requests[0];
      if (!request) return;
      try { await processRequest(request.requestId); }
      finally { await window.electronAPI.finishDocumentOpenRequest(request.requestId); await refreshRequestsRef.current(); }
    };
  });
  const open = () => run(async () => { const request = await window.electronAPI.pickDocumentFile(); if (request) await drainRequestsRef.current(request.requestId); });
  const recent = () => run(async () => {
    const records = await window.electronAPI.listRecentDocuments();
    if (!records.length) { window.alert(t('没有最近打开的独立文件。')); return; }
    const path = await ask(t('最近文件'), '', records.map(record => ({ value: record.displayPath, label: record.displayPath })), true);
    if (path) { const request = await window.electronAPI.openRecentDocument(path); await drainRequestsRef.current(request.requestId); }
  });
  const recover = () => run(async () => {
    const records = await window.electronAPI.listDocumentRecovery();
    if (!records.length) { window.alert(t('没有需要恢复的独立文件草稿。')); return; }
    const id = await ask(t('恢复独立文件草稿'), t('恢复仅加载草稿，不会覆盖原文件。'), records.map(r => ({ value: r.recoveryId, label: `${r.displayPath} · ${new Date(r.updatedAt).toLocaleString()}` })), true);
    if (!id || !await optionsRef.current.beforeOpen()) return;
    // 先解决当前草稿，避免取消切换时丢失被恢复的旧记录。
    const reason = await closeReason(); if (!reason) return;
    const snapshot = await window.electronAPI.restoreDocumentDraft(id); await finishSession(reason); controller.open(snapshot); optionsRef.current.showNotes();
  });
  const join = (libraries: { path: string; alias?: string; name?: string }[]) => run(async () => {
    if (!libraries.length) { window.alert(t('请先创建或登记笔记库。')); return; }
    const library = pendingJoin.current && pendingJoin.current.request.documentSessionId === controller.snapshot?.documentSessionId && pendingJoin.current.request.draftRevision === controller.revision ? pendingJoin.current.request.libraryPath : await ask(t('加入笔记库'), t('复制当前草稿到笔记库，原文件保持现有内容。'), libraries.map(l => ({ value: l.path, label: l.alias ?? l.name ?? l.path })), true);
    if (!library || !controller.snapshot) return;
    await controller.synchronize();
    if (!pendingJoin.current || pendingJoin.current.request.documentSessionId !== controller.snapshot.documentSessionId || pendingJoin.current.request.draftRevision !== controller.revision) pendingJoin.current = { request: { documentSessionId: controller.snapshot.documentSessionId, draftRevision: controller.revision, requestId: crypto.randomUUID(), libraryPath: library } };
    const pending = pendingJoin.current;
    const result = pending.result ?? await window.electronAPI.joinDocumentLibrary(pending.request); pending.result = result;
    routing.current = true;
    try { if (await optionsRef.current.openLibrary(result.libraryPath, result.path)) { await finishSession('transferred', result.transferToken); pendingJoin.current = null; } }
    finally { routing.current = false; }
    if (result.indexState === 'degraded') window.alert(t('副本已保存，索引更新失败，请在笔记库重建索引。'));
  });
  const reload = (chooseEncoding = false) => run(async () => {
    if (!controller.snapshot) return;
    if (controller.dirty && !window.confirm(t('重新加载会放弃当前修改，是否继续？'))) return;
    await controller.synchronize();
    const encoding = chooseEncoding ? await ask(t('选择文本编码'), '', [{ value: 'utf8', label: 'UTF-8' }, { value: 'utf16le', label: 'UTF-16 LE' }, { value: 'utf16be', label: 'UTF-16 BE' }, { value: 'gbk', label: 'GBK' }, { value: 'gb18030', label: 'GB18030' }], true) : controller.snapshot.format.encoding;
    if (!encoding) return;
    const snapshot = await window.electronAPI.refreshDocument(controller.snapshot.documentSessionId, controller.revision, encoding as DocumentEncoding, true);
    controller.open(snapshot);
  });
  useEffect(() => {
    const unsubscribe = window.electronAPI.onDocumentOpenRequested(() => {
      const alreadyQueued = pendingFilesRef.current.length > 0;
      const shouldOpen = !alreadyQueued && !busyRef.current && !optionsRef.current.blocked && !maintained.current;
      void refreshRequestsRef.current().then(requests => { if (requests.length && shouldOpen && !busyRef.current) void run(() => drainRequestsRef.current()); });
    });
    void run(() => drainRequestsRef.current());
    return unsubscribe;
  }, [run]);
  useEffect(() => {
    if (!options.blocked && !maintained.current && !controller.snapshot) void run(() => drainRequestsRef.current());
  }, [options.blocked, controller, run]);
  useEffect(() => {
    const dragover = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []); if (!files.length) return;
      event.preventDefault(); if (optionsRef.current.blocked || maintained.current) return;
      void window.electronAPI.dropDocumentFiles(files).catch(error => window.alert(String(error)));
    };
    window.addEventListener('dragover', dragover); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', dragover); window.removeEventListener('drop', drop); };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); event.stopImmediatePropagation(); void open(); }
      if (event.key.toLowerCase() === 's' && controller.snapshot) { event.preventDefault(); event.stopImmediatePropagation(); void run(async () => { await save(event.shiftKey ? 'saveAs' : 'save'); }, event.shiftKey); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  return { controller, busy, editingBlocked, routing, open, recent, recover, join, reload, prepareTransition, pendingFiles, showPendingFiles: () => setQueueOpened(true),
    save: (mode: 'save' | 'saveAs' = 'save', utf8 = false) => run(async () => { await save(mode, utf8); }, mode === 'saveAs'),
    maintain: async () => { maintained.current = true; await controller.synchronize(); }, releaseMaintenance: () => { maintained.current = false; void refreshRequestsRef.current(); },
    dialog: <><Modal opened={Boolean(choice)} onClose={() => finishChoice(null)} title={choice?.title} centered closeOnClickOutside={false} zIndex={1100}>
      <Stack><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{choice?.message}</Text>
        {choice?.select ? <><Select aria-label={choice.title} value={selected} onChange={setSelected} data={choice.options} searchable comboboxProps={{ zIndex: 1200 }} /><Group justify="flex-end"><Button variant="default" onClick={() => finishChoice(null)}>{t('取消')}</Button><Button onClick={() => finishChoice(selected)} disabled={!selected}>{t('确定')}</Button></Group></> : <Group justify="flex-end">{choice?.options.map(option => <Button key={option.value} data-document-choice={option.value} variant={option.value === 'save' ? 'filled' : 'default'} onClick={() => finishChoice(option.value)}>{option.label}</Button>)}</Group>}
      </Stack>
    </Modal><Modal opened={queueOpened} onClose={() => setQueueOpened(false)} title={t('待打开文件')} centered zIndex={1050}>
      <Stack gap="xs">{pendingFiles.length === 0 && <Text size="sm" c="dimmed">{t('没有待打开文件。')}</Text>}{pendingFiles.map(request => <Group key={request.requestId} wrap="nowrap" data-document-pending={request.requestId}><Text size="xs" title={request.displayPath} style={{ flex: 1, overflowWrap: 'anywhere' }}>{request.displayPath}</Text><Button size="compact-xs" disabled={busy || options.blocked} onClick={() => { setQueueOpened(false); void run(() => drainRequestsRef.current(request.requestId)); }}>{t('打开')}</Button><Button size="compact-xs" variant="subtle" disabled={busy || options.blocked} onClick={() => void run(async () => { await window.electronAPI.finishDocumentOpenRequest(request.requestId); })}>{t('移除')}</Button></Group>)}</Stack>
    </Modal></> };
}
