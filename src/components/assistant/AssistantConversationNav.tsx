import { t, useI18n } from '../../i18n';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Tooltip } from '@mantine/core';
import './AssistantConversationNav.css';

interface NavigationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  state: string;
  error?: string;
  statusMessage?: string;
}

interface ConversationEntry {
  id: string;
  question: string;
  answer: string;
  state: string;
}

interface AssistantConversationNavProps {
  messages: NavigationMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
}

/** 当前会话的问题索引；只读取已展示的消息，不额外读取或修改历史记忆。 */
export default function AssistantConversationNav({ messages, scrollRef, contentRef, onNavigate }: AssistantConversationNavProps) {
  useI18n();
  const entries = useMemo(() => buildConversationEntries(messages), [messages]);
  // 只在问题增删、会话切换时重绑观察器，流式正文更新由 ResizeObserver 跟踪。
  const entryKey = JSON.stringify(entries.map((entry) => entry.id));
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentId = entries.some((entry) => entry.id === activeId) ? activeId : entries.at(-1)?.id;

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const anchors = [...content.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')];
    let frame: number | null = null;
    const updateActive = () => {
      frame = null;
      if (!anchors.length || !scroll.clientHeight) return;
      const readingLine = scroll.getBoundingClientRect().top + Math.min(80, scroll.clientHeight * 0.2);
      let index = 0;
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2) {
        index = anchors.length - 1;
      } else {
        // 消息按阅读顺序排列，二分定位当前阅读的提问，避免逐条测量长会话。
        let low = 0;
        let high = anchors.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (anchors[middle].getBoundingClientRect().top <= readingLine) {
            index = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
      }
      setActiveId(anchors[index].dataset.conversationTurnId ?? null);
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateActive);
    };
    scroll.addEventListener('scroll', scheduleUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroll);
    observer.observe(content);
    scheduleUpdate();
    return () => {
      scroll.removeEventListener('scroll', scheduleUpdate);
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [contentRef, entryKey, scrollRef]);

  useEffect(() => {
    const list = listRef.current;
    const button = [...(list?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((item) => item.dataset.turnId === currentId);
    if (!list || !button) return;
    // 只移动导航条自身；不让长会话的索引把消息区或整个页面一起滚动。
    const listRect = list.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (buttonRect.top < listRect.top) list.scrollTop += buttonRect.top - listRect.top;
    else if (buttonRect.bottom > listRect.bottom) list.scrollTop += buttonRect.bottom - listRect.bottom;
  }, [currentId, entryKey]);

  const navigateTo = (entry: ConversationEntry) => {
    const scroll = scrollRef.current;
    const anchor = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-conversation-turn-id]') ?? [])]
      .find((element) => element.dataset.conversationTurnId === entry.id);
    if (!scroll || !anchor) return;
    const top = Math.max(0, Math.min(
      scroll.scrollHeight - scroll.clientHeight,
      scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24,
    ));
    if (Math.abs(scroll.scrollTop - top) > 1) onNavigate();
    setActiveId(entry.id);
    // 立即定位，避免长会话滚动动画经过其他问题时反复切换阅读位置。
    scroll.scrollTo({ top, behavior: 'instant' });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number;
    if (event.key === 'ArrowDown') target = Math.min(entries.length - 1, index + 1);
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = entries.length - 1;
    else return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('button')[target]?.focus();
  };

  if (!entries.length) return null;
  return (
    <nav className="assistant-conversation-nav" aria-label={t("当前会话导航，共 {0} 次提问", { '0': entries.length })}>
      <div ref={listRef} className="assistant-conversation-nav-list">
        {entries.map((entry, index) => (
          <Tooltip
            key={entry.id}
            position="right"
            offset={12}
            openDelay={140}
            closeDelay={80}
            transitionProps={{ duration: 0 }}
            events={{ hover: true, focus: true, touch: false }}
            multiline
            classNames={{ tooltip: 'assistant-conversation-nav-preview' }}
            label={(
              <div>
                <strong className="assistant-conversation-nav-question">{entry.question}</strong>
                <p className="assistant-conversation-nav-answer">{entry.answer}</p>
                <div className="assistant-conversation-nav-preview-footer">
                  <span>{t("第")} {index + 1} / {entries.length} {t("次提问")}{entry.state === 'pending' || entry.state === 'streaming' ? t(" · 回答中") : entry.state === 'error' ? t(" · 未完成") : entry.state === 'cancelled' ? t(" · 已取消") : ''}</span>
                  <span>{t("点击定位")}</span>
                </div>
              </div>
            )}
          >
            <button
              type="button"
              className="assistant-conversation-nav-item"
              data-turn-id={entry.id}
              aria-label={t("第 {0} 次提问：{1}", { '0': index + 1, '1': entry.question })}
              aria-current={entry.id === currentId ? 'location' : undefined}
              tabIndex={entry.id === currentId ? 0 : -1}
              onClick={() => navigateTo(entry)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span aria-hidden="true" />
            </button>
          </Tooltip>
        ))}
      </div>
    </nav>
  );
}

/** 按消息顺序配对问题与回答，保留失败和取消轮次的可定位入口。 */
function buildConversationEntries(messages: NavigationMessage[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      entries.push({ id: message.id, question: previewText(message.content) || t("附件提问"), answer: t("正在准备回答…"), state: 'pending' });
    } else {
      const entry = entries.at(-1);
      if (!entry) continue;
      entry.state = message.state;
      entry.answer = previewText(message.content) || (message.state === 'error' ? message.error || t("本轮未能完成。")
        : message.state === 'cancelled' ? t("本轮回答已取消。")
        : message.state === 'complete' ? t("本轮没有文字回答。")
        : message.statusMessage || t("正在生成回答…"));
    }
  }
  return entries;
}

/** 将 Markdown 开头转换为有长度上限的纯文本预览，避免渲染大段正文或工具内容。 */
function previewText(value: string): string {
  return value.slice(0, 1600)
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/\*\*|__|`|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
