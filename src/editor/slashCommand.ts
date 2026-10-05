import { Extension, type Editor, type Range } from '@tiptap/core';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { t } from '../i18n';

export interface SlashCommandItem {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
}

export const slashCommandItems: SlashCommandItem[] = [
  command('text', '正文', '普通文本段落', ['paragraph', 'text', '正文'], (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run()),
  command('heading-1', '一级标题', '大标题', ['h1', 'title', '标题'], (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run()),
  command('heading-2', '二级标题', '章节标题', ['h2', 'subtitle', '标题'], (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run()),
  command('heading-3', '三级标题', '小节标题', ['h3', 'heading', '标题'], (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run()),
  command('bullet-list', '无序列表', '创建项目符号列表', ['bullet', 'list', '列表'], (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run()),
  command('ordered-list', '有序列表', '创建编号列表', ['number', 'ordered', '列表'], (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()),
  command('task-list', '待办列表', '创建可勾选任务', ['todo', 'task', '待办'], (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run()),
  command('blockquote', '引用', '插入引用段落', ['quote', '引用'], (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run()),
  command('code-block', '代码块', '插入代码区域', ['code', '代码'], (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run()),
  command('divider', '分割线', '插入水平分割线', ['divider', 'rule', '分割线'], (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run()),
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const normalized = query.trim().toLocaleLowerCase('zh-Hans-CN');
  if (!normalized) return slashCommandItems;
  return slashCommandItems.filter((item) => [item.label, item.description, t(item.label), t(item.description), ...item.keywords]
    .some((value) => value.toLocaleLowerCase('zh-Hans-CN').includes(normalized)));
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [Suggestion<SlashCommandItem, SlashCommandItem>({
      editor: this.editor,
      char: '/',
      startOfLine: false,
      allowedPrefixes: null,
      items: ({ query }) => filterSlashCommands(query),
      command: ({ editor, range, props }) => props.run(editor, range),
      render: createSlashCommandRenderer,
    })];
  },
});

function createSlashCommandRenderer() {
  let menu: HTMLDivElement | null = null;
  let currentProps: SuggestionProps<SlashCommandItem, SlashCommandItem> | null = null;
  let selectedIndex = 0;

  const removeMenu = () => {
    menu?.remove();
    menu = null;
    currentProps = null;
    selectedIndex = 0;
  };

  const updatePosition = () => {
    const rect = currentProps?.clientRect?.();
    if (!menu || !rect) return;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
    menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
  };

  const renderItems = () => {
    if (!menu || !currentProps) return;
    selectedIndex = Math.min(selectedIndex, Math.max(0, currentProps.items.length - 1));
    menu.replaceChildren();
    if (currentProps.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-command-empty';
      empty.textContent = t('没有匹配的命令');
      menu.append(empty);
      updatePosition();
      return;
    }

    currentProps.items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `slash-command-item${index === selectedIndex ? ' selected' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === selectedIndex));
      const label = document.createElement('strong');
      label.textContent = t(item.label);
      const description = document.createElement('span');
      description.textContent = t(item.description);
      button.append(label, description);
      button.addEventListener('mouseenter', () => { selectedIndex = index; renderItems(); });
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        currentProps?.command(item);
      });
      menu?.append(button);
    });
    updatePosition();
  };

  return {
    onStart: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      removeMenu();
      currentProps = props;
      menu = document.createElement('div');
      menu.className = 'slash-command-menu';
      menu.setAttribute('role', 'listbox');
      document.body.append(menu);
      renderItems();
    },
    onUpdate: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      currentProps = props;
      selectedIndex = 0;
      renderItems();
    },
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (!currentProps || !menu) return false;
      if (event.key === 'Escape') {
        removeMenu();
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const count = currentProps.items.length;
        if (count > 0) selectedIndex = (selectedIndex + direction + count) % count;
        renderItems();
        return true;
      }
      if (event.key === 'Enter' && currentProps.items[selectedIndex]) {
        currentProps.command(currentProps.items[selectedIndex]);
        return true;
      }
      return false;
    },
    onExit: removeMenu,
  };
}

function command(
  id: string,
  label: string,
  description: string,
  keywords: string[],
  run: SlashCommandItem['run'],
): SlashCommandItem {
  return { id, label, description, keywords, run };
}
