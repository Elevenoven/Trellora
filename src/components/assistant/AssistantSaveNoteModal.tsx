import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Loader, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { t, useI18n } from '../../i18n';
import type { LibrarySummary } from '../../electron';
import { normalizeAssistantNoteTitle, type CreateAssistantNoteResult } from '../../../shared/assistantNote';
import MarkdownContent from '../MarkdownContent';
import './AssistantSaveNoteModal.css';

interface AssistantSaveNoteModalProps {
  content: string;
  currentPath: string | null;
  libraryPath: string | null;
  onClose: () => void;
  onSaved: (note: CreateAssistantNoteResult) => void;
}

const markdownExtensions = [markdown(), EditorView.lineWrapping];

/** Keep a separate Markdown draft; choosing a library is required before any file is created. */
export default function AssistantSaveNoteModal({ content, currentPath, libraryPath, onClose, onSaved }: AssistantSaveNoteModalProps) {
  useI18n();
  const [draft, setDraft] = useState(content);
  const [title, setTitle] = useState('');
  const [step, setStep] = useState<'edit' | 'library'>('edit');
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    if (step !== 'library') return;
    let cancelled = false;
    setLoading(true);
    setTargetPath(null);
    setError(null);
    void window.electronAPI.listLibraries().then(items => {
      if (!cancelled) setLibraries(items.filter(item => item.exists));
    }).catch((failure: unknown) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [step]);

  const chooseLibrary = () => {
    try {
      normalizeAssistantNoteTitle(title);
      if (!draft.trim()) throw new Error(t('笔记正文不能为空。'));
      setError(null);
      setStep('library');
    } catch (failure) { setError(failure instanceof Error ? t(failure.message) : String(failure)); }
  };

  const save = async () => {
    if (!targetPath || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const note = await window.electronAPI.createNoteFromAssistant({ libraryPath: targetPath, title, content: draft });
      if (aliveRef.current) onSaved(note);
    } catch (failure) {
      if (aliveRef.current) setError(failure instanceof Error ? t(failure.message) : String(failure));
    } finally {
      savingRef.current = false;
      if (aliveRef.current) setSaving(false);
    }
  };

  return <Modal opened onClose={() => { if (!savingRef.current) onClose(); }} title={t(step === 'edit' ? '保存 AI 回复为笔记' : '选择笔记库')}
    centered size={step === 'edit' ? '80rem' : 'sm'} className="assistant-save-note-modal" closeOnClickOutside={!saving} closeOnEscape={!saving} withCloseButton={!saving}>
    <Stack gap="sm">
      {step === 'edit' ? <>
        <TextInput label={t('笔记标题')} placeholder={t('留空时自动命名为未命名[1]、未命名[2]…')} value={title} onChange={event => setTitle(event.currentTarget.value)} maxLength={154} data-autofocus />
        <div className="assistant-note-draft-grid">
          <section className="assistant-note-draft-pane">
            <Text size="xs" fw={600} className="assistant-note-pane-label">{t('Markdown 正文')}</Text>
            <CodeMirror value={draft} onChange={setDraft} extensions={markdownExtensions} theme="none" height="100%" aria-label={t('Markdown 正文')}
              basicSetup={{ foldGutter: true, highlightActiveLine: false, highlightActiveLineGutter: false }} />
          </section>
          <section className="assistant-note-draft-pane">
            <Text size="xs" fw={600} className="assistant-note-pane-label">{t('实时预览')}</Text>
            <div className="assistant-note-preview-scroll">
              <MarkdownContent content={draft} currentPath={currentPath} libraryPath={libraryPath} className="assistant-markdown-content assistant-note-draft-preview" showCodeCopyActions disableApplicationLinks />
            </div>
          </section>
        </div>
      </> : <>
        <Text size="sm" fw={600}>{title.trim() || t('未命名笔记')}</Text>
        {loading ? <Group justify="center"><Loader size="sm" /></Group> : <Select label={t('目标笔记库')} placeholder={t('选择笔记库')}
          data={libraries.map(item => ({ value: item.path, label: item.alias }))} value={targetPath} onChange={setTargetPath}
          searchable allowDeselect={false} disabled={saving || !libraries.length} comboboxProps={{ withinPortal: false }} />}
        {!loading && !libraries.length && !error ? <Text size="sm" c="dimmed">{t('还没有可用的笔记库，请先在笔记库管理中添加或创建笔记库。')}</Text> : null}
      </>}
      {error ? <Alert color="red" role="alert">{error}</Alert> : null}
      <Group justify="flex-end" gap="sm">
        <Button variant="default" disabled={saving} onClick={step === 'edit' ? onClose : () => { setError(null); setStep('edit'); }}>{t(step === 'edit' ? '取消' : '返回编辑')}</Button>
        <Button onClick={step === 'edit' ? chooseLibrary : () => void save()} loading={saving} disabled={step === 'edit' ? !draft.trim() : loading || !targetPath}>{t(step === 'edit' ? '保存' : '保存笔记')}</Button>
      </Group>
    </Stack>
  </Modal>;
}
