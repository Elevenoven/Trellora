import { useCallback, useMemo } from 'react';
import { ActionIcon } from '@mantine/core';
import { Bot, FileText, X } from 'lucide-react';
import { KnowledgeAssistant, type KnowledgeAssistantProps } from './KnowledgePanel';
import type { AssistantTurnRequest } from '../electron';
import type { DocumentSaveController } from '../utils/documentSaveController';
import { t, useI18n } from '../i18n';

interface Props {
  assistant: KnowledgeAssistantProps;
  controller: DocumentSaveController;
  blocked: boolean;
  onClose: () => void;
  onNavigateLine: (line: number) => void;
}

/** 只绑定当前文件草稿；复用对话界面，不带入库检索或库内会话记忆。 */
export default function ExternalDocumentAssistant({ assistant, controller, blocked, onClose, onNavigateLine }: Props) {
  useI18n();
  const snapshot = controller.snapshot!;
  const documentSessionId = snapshot.documentSessionId;
  const title = snapshot.displayPath.split(/[\\/]/).at(-1) || t('当前文件');
  const currentDocument = useMemo(() => ({
    documentSessionId,
    title,
    prepare: async () => {
      if (blocked) throw new Error(t('维护期间暂不能发送问题。'));
      const draftRevision = controller.revision;
      if (controller.snapshot?.documentSessionId !== documentSessionId) throw new Error(t('文档已切换，请重新提问。'));
      await controller.synchronize();
      if (controller.snapshot?.documentSessionId !== documentSessionId || controller.revision !== draftRevision) throw new Error(t('文档草稿已变化，请重新提问。'));
      return { documentSessionId, draftRevision };
    },
  }), [documentSessionId, title, blocked, controller]);
  const onStartAssistantTurn = assistant.onStartAssistantTurn;
  const startTurn = useCallback((request: AssistantTurnRequest) => {
    if (blocked) return Promise.reject(new Error(t('维护期间暂不能发送问题。')));
    return onStartAssistantTurn(request);
  }, [blocked, onStartAssistantTurn]);

  return <>
    <header className="external-document-assistant-header">
      <span className="external-document-assistant-mark"><Bot size={19} aria-hidden="true" /></span>
      <div><strong>{t('当前文件 AI 助手')}</strong><span title={snapshot.displayPath}><FileText size={12} aria-hidden="true" />{title}</span></div>
      <ActionIcon variant="subtle" color="gray" aria-label={t('关闭 AI 助手')} title={t('关闭 AI 助手')} onClick={onClose}><X size={17} /></ActionIcon>
    </header>
    <p className="external-document-assistant-description">{t('分析当前打开文件的内容，包含尚未保存的修改。')}</p>
    <div className="external-document-assistant-content"><KnowledgeAssistant {...assistant} libraryPath={null} noteMeta={null} assistantContextRevision={0} fixedContextSources={undefined} contextSourceOptions={undefined} workspaceMemory={undefined} currentDocument={currentDocument} onStartAssistantTurn={startTurn} onNavigateAssistantCitation={async citation => {
      const revision = controller.revision;
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(controller.content));
      const contentHash = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      if (controller.snapshot?.documentSessionId !== documentSessionId || controller.snapshot.displayPath !== citation.notePath || controller.revision !== revision || contentHash !== citation.contentHash) return { status: 'stale', message: t('文档草稿已变化，请重新提问。') };
      onNavigateLine(citation.lineFrom);
      return { status: 'valid' };
    }} debugRailOpen={false} hideDebugRailToggle /></div>
  </>;
}
