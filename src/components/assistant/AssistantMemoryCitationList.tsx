import { useEffect, useRef, useState } from 'react';
import { Modal } from '@mantine/core';
import { Database, LoaderCircle } from 'lucide-react';
import { t, useI18n } from '../../i18n';
import type { MemoryCitationSnapshot, MemoryCitationSource } from '../../../shared/memoryCitations';
import { getReferencedMemoryCitations, memoryCitationElementId } from '../assistantMemoryCitations';

interface Props {
  turnId: string;
  content: string;
  memories: readonly MemoryCitationSnapshot[];
  expandedReference: number | null;
  onToggle: (reference: number) => void;
}

export default function AssistantMemoryCitationList({ turnId, content, memories, expandedReference, onToggle }: Props) {
  useI18n();
  const [sourceItem, setSourceItem] = useState<MemoryCitationSnapshot | null>(null);
  const [source, setSource] = useState<MemoryCitationSource | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const sourceRequest = useRef(0);
  useEffect(() => () => { sourceRequest.current++; }, []);
  const referenced = getReferencedMemoryCitations(content, memories);
  const shown = referenced.length ? referenced : memories;
  // Legacy display numbers are navigation labels, never a mapping for old [N] text.
  const entries = shown.map((snapshot, index) => ({ snapshot, reference: snapshot.reference ?? index + 1 }));
  const expanded = entries.find((entry) => entry.reference === expandedReference);

  function closeSource() { sourceRequest.current++; setSourceItem(null); setSource(null); setSourceError(false); }
  async function openSource(snapshot: MemoryCitationSnapshot) {
    const version = ++sourceRequest.current;
    setSourceItem(snapshot); setSource(null); setSourceError(false);
    try {
      if (!window.electronAPI?.getLongTermMemoryCitationSource) throw new Error('memory source API unavailable');
      const result = await window.electronAPI.getLongTermMemoryCitationSource(turnId, snapshot.itemId);
      if (version === sourceRequest.current) setSource(result);
    } catch { if (version === sourceRequest.current) setSourceError(true); }
  }

  if (!entries.length) return null;
  return <section className="assistant-knowledge-base-citations assistant-memory-citations" aria-label={t('记忆引用')}>
    <strong>{referenced.length ? t('记忆引用') : t('本次提供记忆')}</strong>
    <div className="assistant-knowledge-base-citation-list">{entries.map(({ snapshot, reference }) => <button key={snapshot.itemId} type="button" className="assistant-knowledge-base-citation-link" data-memory="true" aria-expanded={expandedReference === reference} aria-controls={memoryCitationElementId(turnId, reference)} onClick={() => onToggle(reference)} title={snapshot.contentSnapshot}>
      <Database size={11} aria-hidden="true" /><span>{t('记忆 {0}', { '0': reference })}</span>
    </button>)}</div>
    {expanded ? <article id={memoryCitationElementId(turnId, expanded.reference)} className="assistant-knowledge-base-citation-detail assistant-memory-citation-detail">
      <header><strong>{expanded.snapshot.topic || t('记忆 {0}', { '0': expanded.reference })}</strong><span>{t('长期记忆')}</span></header>
      <pre>{expanded.snapshot.contentSnapshot}</pre>
      <div className="assistant-memory-citation-footer"><span>{t('本次回答使用时的记忆内容')}</span>
        {expanded.snapshot.origin === 'manual' ? <span>{t('手工维护，无原始对话')}</span> : expanded.snapshot.sourceMessageId ? <button type="button" className="assistant-message-copy-button" onClick={() => { void openSource(expanded.snapshot); }}>{t('查看原始对话')}</button> : <span>{t('未记录原始对话来源')}</span>}
      </div>
    </article> : null}
    <Modal opened={Boolean(sourceItem)} onClose={closeSource} title={t('记忆的原始对话')} centered size="md" className="assistant-memory-source-modal">
      {sourceError ? <div role="alert">{t('读取来源失败，请重试')}<button type="button" className="assistant-message-copy-button" onClick={() => { if (sourceItem) void openSource(sourceItem); }}>{t('重试')}</button></div> : !source ? <div className="assistant-memory-source-loading"><LoaderCircle size={14} aria-hidden="true" />{t('正在读取原始对话…')}</div> : source.status === 'available' ? <><div className="assistant-memory-source-meta">{t('你')}{source.createdAt ? ` · ${new Date(source.createdAt).toLocaleString()}` : ''}</div><div className="assistant-memory-source-quote">{source.userText}</div></> : <div>{source.status === 'manual' ? t('手工维护，无原始对话') : t('原始对话已删除或不可用；回答当时的记忆内容仍已保留。')}</div>}
    </Modal>
  </section>;
}
