import { useRef, useState } from 'react';
import { Button, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import type { DocumentAiAction, DocumentAiResult, DocumentAiSelection } from '../../shared/documentAi';
import type { useExternalDocuments } from '../hooks/useExternalDocuments';
import type { LibrarySummary } from '../electron';
import { t } from '../i18n';

/** 建议显式审阅后写回草稿；继续输入时保留结果并让主进程拒绝旧版本。 */
export default function ExternalDocumentAiPanel({ documents, getSelection, libraries, blocked }: { documents: ReturnType<typeof useExternalDocuments>; getSelection: () => DocumentAiSelection | undefined; libraries: LibrarySummary[]; blocked: boolean }) {
  const [action, setAction] = useState<DocumentAiAction>('rewrite'), [question, setQuestion] = useState(''), [library, setLibrary] = useState<string | null>(null), [language, setLanguage] = useState<'en' | 'zh-CN'>('en');
  const [result, setResult] = useState<DocumentAiResult>(), [error, setError] = useState(''), [working, setWorking] = useState(false); const requestId = useRef<string>();
  const execute = async () => {
    if (working || blocked || documents.busy || !documents.controller.snapshot) return;
    setWorking(true); setError(''); const id = crypto.randomUUID(); requestId.current = id;
    try { await documents.controller.synchronize(); const snapshot = documents.controller.snapshot; const answer = await window.electronAPI.runDocumentAi({ documentSessionId: snapshot.documentSessionId, draftRevision: documents.controller.revision, requestId: id, action, selection: getSelection(), question, targetLanguage: language, libraryPath: library ?? undefined }); setResult(answer); }
    catch (failure) { setError(String(failure)); } finally { setWorking(false); }
  };
  const apply = async () => {
    if (!result || blocked || documents.busy || working) return;
    try { await documents.controller.synchronize(); const snapshot = await window.electronAPI.applyDocumentAi({ receiptId: result.receiptId, documentSessionId: documents.controller.snapshot!.documentSessionId, draftRevision: documents.controller.revision, selection: getSelection() }); documents.controller.acceptDraft(snapshot); setResult(undefined); setError(''); }
    catch (failure) { setError(String(failure)); }
  };
  return <div className="external-ai-panel" data-testid="external-document-ai"><Stack gap="xs">
    <Text fw={600} size="sm">{t('当前文档 AI')}</Text><Text size="xs" c="dimmed">{t('直接使用当前草稿。改写和翻译需要源码选区；建议应用后仍需手动保存。')}</Text>
    <Select aria-label={t('文档 AI 操作')} value={action} onChange={value => setAction(value as DocumentAiAction)} data={[{ value: 'rewrite', label: t('改写选区') }, { value: 'translate', label: t('翻译选区') }, { value: 'summary', label: t('摘要') }, { value: 'question', label: t('文档问答') }]} />
    {action === 'translate' && <Select aria-label={t('目标语言')} value={language} onChange={value => setLanguage(value as 'en' | 'zh-CN')} data={[{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]} />}
    {action === 'question' && <Textarea aria-label={t('文档问题')} placeholder={t('输入关于当前文档的问题')} value={question} onChange={event => setQuestion(event.currentTarget.value)} autosize minRows={2} />}
    <Select aria-label={t('补充笔记库')} placeholder={t('仅使用当前文档')} clearable value={library} onChange={setLibrary} data={libraries.map(item => ({ value: item.path, label: item.alias || item.path }))} />
    <Group gap="xs"><Button size="xs" loading={working} disabled={blocked || documents.busy} onClick={() => void execute()}>{t('生成建议')}</Button>{working && <Button size="xs" variant="subtle" onClick={() => void window.electronAPI.cancelDocumentAi(requestId.current!)}>{t('取消')}</Button>}</Group>
    {error && <Text size="xs" c="red" role="alert">{error}</Text>}
    {result && <><Text size="xs" c="dimmed">{t(result.scope === 'selection' ? '本次使用选区' : '本次使用整篇文档')} · ≈{result.inputTokensEstimate} tokens</Text><Text component="pre" className="external-ai-result">{result.text}</Text><Group gap="xs"><Button size="xs" variant="default" onClick={() => void navigator.clipboard.writeText(result.text)}>{t('复制')}</Button>{['rewrite', 'translate'].includes(result.action) && <Button size="xs" disabled={blocked || documents.busy || working} onClick={() => void apply()}>{t('应用到选区')}</Button>}</Group></>}
  </Stack></div>;
}
