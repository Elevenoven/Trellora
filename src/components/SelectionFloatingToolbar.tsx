import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';
import { Bold, Italic, Strikethrough, Code, Link, Sparkles } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { SelectionSnapshot } from '../editor/selectionActions';
import { t, useI18n } from '../i18n';

/** Presentation only: commands and AI reuse the owning overlay's validated snapshot. */
export default function SelectionFloatingToolbar({ editor, snapshot, onAction, allowDocumentAi = true, aiDisabledReason }: {
  editor: Editor; snapshot: SelectionSnapshot; onAction: (action: string) => void; allowDocumentAi?: boolean; aiDisabledReason?: string;
}) {
  useI18n();
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const enterToolbar = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const button = toolbarRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (!button) return;
      event.preventDefault(); button.focus({ preventScroll: true });
    };
    const dom = editor.view.dom;
    dom.addEventListener('keydown', enterToolbar, true);
    return () => dom.removeEventListener('keydown', enterToolbar, true);
  }, [editor]);
  const { rect } = snapshot;
  const viewport = editor.view.dom.closest('.editor-viewport')?.getBoundingClientRect();
  const width = allowDocumentAi ? 238 : 200;
  const minLeft = Math.max(8, (viewport?.left ?? 0) + 8);
  const maxRight = Math.min(window.innerWidth, viewport?.right ?? window.innerWidth) - 8;
  const minTop = Math.max(8, (viewport?.top ?? 0) + 8);
  const maxTop = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight) - 48;
  const left = Math.max(minLeft, Math.min((rect.left + rect.right - width) / 2, maxRight - width));
  const top = Math.max(minTop, Math.min(rect.top - 46 >= minTop ? rect.top - 46 : rect.bottom + 8, maxTop));
  const actions = [
    { action: 'bold', label: '粗体', Icon: Bold }, { action: 'italic', label: '斜体', Icon: Italic },
    { action: 'strike', label: '删除线', Icon: Strikethrough }, { action: 'code', label: '行内代码', Icon: Code },
    { action: 'link', label: '链接', Icon: Link }, { action: 'ai', label: 'AI 编辑', Icon: Sparkles },
  ];
  return createPortal(<div ref={toolbarRef} className="selection-floating-toolbar" role="toolbar" aria-label={t('选区浮动工具栏')} style={{ left, top }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) editor.view.focus();
    if (event.key === 'Tab' && event.shiftKey && event.target === toolbarRef.current?.querySelector('button:not(:disabled)')) {
      event.preventDefault(); editor.view.focus();
    }
  }}>
    {actions.filter(item => allowDocumentAi || item.action !== 'ai').map(({ action, label, Icon }) =>
      <button key={action} type="button" title={action === 'ai' && aiDisabledReason ? aiDisabledReason : t(label)} aria-label={t(label)} disabled={action === 'ai' && Boolean(aiDisabledReason)} aria-pressed={['bold', 'italic', 'strike', 'code'].includes(action) ? editor.isActive(action) : undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => onAction(action)}><Icon size={16} aria-hidden="true" /></button>)}
  </div>, document.body);
}
