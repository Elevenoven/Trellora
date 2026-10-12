import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from '@mantine/core';
import { Bot, EyeOff, Minus, Pin, PinOff, Settings2 } from 'lucide-react';
import type { EditorPreferences } from '../../../shared/editorPreferences';
import { t, useI18n } from '../../i18n';
import './FocusAssistant.css';

export interface FocusAssistantOptions {
  active: boolean;
  preferences: EditorPreferences;
  onSave: (patch: Partial<EditorPreferences>) => Promise<unknown>;
  onOpenSettings: (section: 'editor' | 'model') => void;
  onVisibilityChange: (visible: boolean) => void;
}

interface FocusAssistantProps extends FocusAssistantOptions {
  sidebarTarget: HTMLDivElement | null;
  sidebarActive: boolean;
  noteTitle?: string;
  renderAssistant: (floating: boolean, width: number) => ReactNode;
}

type Position = { side: 'left' | 'right'; position: number };
const buttonSize = 48;
const edgeGap = 16;

/** Move one stable assistant host between the sidebar and focus window, retaining drafts and streams. */
export default function FocusAssistant({ active, preferences, onSave, onOpenSettings, onVisibilityChange, sidebarTarget, sidebarActive, noteTitle, renderAssistant }: FocusAssistantProps) {
  useI18n();
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'focus-assistant-host';
    return element;
  });
  const floatingTarget = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [menuOpened, setMenuOpened] = useState(false);
  const [bounds, setBounds] = useState({ top: 96, bottom: window.innerHeight - edgeGap - buttonSize, width: window.innerWidth });
  const [dragPosition, setDragPosition] = useState<Position | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean; latest: Position } | null>(null);
  const suppressClick = useRef(false);
  const available = active && preferences.editorFocusAiButtonVisible;
  const shown = available && opened;
  const position = dragPosition ?? { side: preferences.editorFocusAiButtonSide, position: preferences.editorFocusAiButtonPosition };
  const buttonTop = bounds.top + position.position * Math.max(0, bounds.bottom - bounds.top);
  const panelWidth = Math.min(420, Math.max(300, bounds.width * 0.36));

  const save = (patch: Partial<EditorPreferences>) => {
    void onSave(patch).catch(error => window.alert(error instanceof Error ? error.message : String(error)));
  };
  const minimize = useCallback(() => {
    setOpened(false);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.focus-assistant-launcher:not([hidden]) button')?.focus());
  }, []);

  useLayoutEffect(() => {
    // Changing a React portal target remounts its content; move the stable host instead.
    const target = available ? floatingTarget.current : sidebarTarget ?? floatingTarget.current;
    target?.appendChild(host);
  }, [available, host, sidebarTarget]);

  useEffect(() => () => host.remove(), [host]);
  useEffect(() => {
    if (sidebarActive || opened) setInitialized(true);
  }, [opened, sidebarActive]);
  useEffect(() => {
    if (!available) { setOpened(false); setMenuOpened(false); }
  }, [available]);
  useEffect(() => {
    onVisibilityChange(shown);
    return () => onVisibilityChange(false);
  }, [onVisibilityChange, shown]);

  useLayoutEffect(() => {
    if (!active) return;
    const toolbar = document.querySelector<HTMLElement>('.notes-main-view .editor-mode-bar');
    const measure = () => {
      const top = Math.max(80, (toolbar?.getBoundingClientRect().bottom ?? 68) + 12);
      const bottom = Math.max(top, window.innerHeight - edgeGap - buttonSize);
      setBounds({ top, bottom, width: window.innerWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (toolbar) observer.observe(toolbar);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [active]);

  /** Pointer capture keeps dragging bounded to the edges without selecting or editing note text. */
  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || preferences.editorFocusAiButtonPinned) return;
    suppressClick.current = false;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, latest: position };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.moved && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 5) return;
    state.moved = true;
    suppressClick.current = true;
    state.latest = {
      side: event.clientX < bounds.width / 2 ? 'left' : 'right',
      position: Math.max(0, Math.min(1, (event.clientY - buttonSize / 2 - bounds.top) / Math.max(1, bounds.bottom - bounds.top))),
    };
    setDragPosition(state.latest);
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragPosition(null);
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    if (state.moved && event.type !== 'pointercancel') save({ editorFocusAiButtonSide: state.latest.side, editorFocusAiButtonPosition: state.latest.position });
  };

  return <>
    {createPortal(<div className="focus-assistant-layer" data-side={position.side}>
      <div className="focus-assistant-launcher" hidden={!available} style={{ top: buttonTop }}>
        <Menu opened={menuOpened} onChange={value => { if (!value) setMenuOpened(false); }} position={position.side === 'right' ? 'top-end' : 'top-start'} shadow="md" width={200} zIndex={1510}>
          <Menu.Target>
            <button ref={launcherRef} type="button" className="focus-assistant-button" data-pinned={preferences.editorFocusAiButtonPinned || undefined} data-dragging={Boolean(dragPosition) || undefined}
              aria-label={t(shown ? '最小化 AI 助手' : '打开专注 AI 助手')} aria-expanded={shown} aria-controls="focus-assistant-panel" aria-haspopup="menu"
              title={t(preferences.editorFocusAiButtonPinned ? '位置已固定；右键取消固定或隐藏' : '可拖动到页面边缘；右键固定或隐藏')}
              onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}
              onLostPointerCapture={() => { drag.current = null; setDragPosition(null); }}
              onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setMenuOpened(false); setOpened(value => !value); }}
              onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenuOpened(true); }}
              onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuOpened(true); } }}>
              <Bot size={22} aria-hidden="true" /><span>AI</span>
              {preferences.editorFocusAiButtonPinned && <Pin className="focus-assistant-pin" size={10} aria-hidden="true" />}
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={preferences.editorFocusAiButtonPinned ? <PinOff size={15} /> : <Pin size={15} />} onClick={() => save({ editorFocusAiButtonPinned: !preferences.editorFocusAiButtonPinned })}>{t(preferences.editorFocusAiButtonPinned ? '取消固定' : '固定位置')}</Menu.Item>
            <Menu.Item leftSection={<EyeOff size={15} />} onClick={() => save({ editorFocusAiButtonVisible: false })}>{t('隐藏 AI 按钮')}</Menu.Item>
            <Menu.Divider />
            <Menu.Item leftSection={<Settings2 size={15} />} onClick={() => onOpenSettings('editor')}>{t('AI 按钮设置')}</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
      <section id="focus-assistant-panel" className="focus-assistant-panel" hidden={!shown} role="dialog" aria-modal="false" aria-label={t('专注 AI 助手')} style={{ top: bounds.top }}
        onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && !menuOpened) { event.preventDefault(); event.stopPropagation(); minimize(); } }}>
        <header className="focus-assistant-header">
          <div><strong><Bot size={17} />{t('AI 助手')}</strong><small title={noteTitle}>{noteTitle || t('当前笔记问答')}</small></div>
          <button type="button" aria-label={t('模型设置')} title={t('模型设置')} onClick={() => onOpenSettings('model')}><Settings2 size={16} /></button>
          <button type="button" aria-label={t('最小化 AI 助手')} title={t('最小化 AI 助手')} onClick={minimize}><Minus size={17} /></button>
        </header>
        <div ref={floatingTarget} className="focus-assistant-content" />
      </section>
    </div>, document.body)}
    {(initialized || sidebarActive || opened) && createPortal(renderAssistant(available, panelWidth), host)}
  </>;
}
