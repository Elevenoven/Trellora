import { getAppLanguage, t, useI18n } from '../../i18n';
import { Alert, Button, Drawer, Group, Menu, Modal, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { History, MessageSquareText, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WikiAiMemory } from '../../electron';

interface MemoryContextMenu {
  memory: WikiAiMemory;
  x: number;
  y: number;
}

interface WikiAiMemoryDrawerProps {
  opened: boolean;
  documentTitle: string;
  memories: WikiAiMemory[];
  onClose: () => void;
  onSetPinned: (memoryId: string, pinned: boolean) => Promise<void>;
  onRename: (memoryId: string, title: string) => Promise<void>;
  onDelete: (memoryId: string) => Promise<void>;
}

/** 当前 Wiki 文档的本地 AI 会话记忆；置顶、重命名与删除通过右键菜单管理。 */
export default function WikiAiMemoryDrawer({
  opened,
  documentTitle,
  memories,
  onClose,
  onSetPinned,
  onRename,
  onDelete,
}: WikiAiMemoryDrawerProps) {
  useI18n();
  const [contextMenu, setContextMenu] = useState<MemoryContextMenu | null>(null);
  const [renameTarget, setRenameTarget] = useState<WikiAiMemory | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WikiAiMemory | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (opened) return;
    setContextMenu(null);
    setRenameTarget(null);
    setDeleteTarget(null);
    setActionError(null);
  }, [opened]);

  const saveRename = async () => {
    if (!renameTarget || !renameTitle.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      await onRename(renameTarget.id, renameTitle.trim());
      setRenameTarget(null);
      setRenameTitle('');
    } catch (error) {
      setActionError(toMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    setActionError(null);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(toMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const togglePinned = async (memory: WikiAiMemory) => {
    setSaving(true);
    setActionError(null);
    setContextMenu(null);
    try {
      await onSetPinned(memory.id, !memory.pinned);
    } catch (error) {
      setActionError(toMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={368}
      title={<Group gap={8}><History size={17} /><Text fw={700}>{t("Wiki AI 记忆")}</Text></Group>}
      classNames={{ body: 'wiki-ai-memory-drawer-body' }}
    >
      <Stack gap="sm" h="100%">
        <div className="wiki-ai-memory-summary">
          <Text size="sm" fw={650} lineClamp={1}>{documentTitle}</Text>
          <Text size="xs" c="dimmed" mt={3}>{t("每次新建对话都会保留为独立记忆；右键可置顶、重命名或删除。")}</Text>
        </div>
        {actionError ? <Alert color="red" variant="light" title={t("操作未完成")}>{actionError}</Alert> : null}
        <ScrollArea className="wiki-ai-memory-scroll" type="auto">
          {memories.length === 0 ? (
            <div className="wiki-ai-memory-empty">
              <MessageSquareText size={20} />
              <Text size="sm" fw={600}>{t("还没有 AI 记忆")}</Text>
              <Text size="xs" c="dimmed">{t("完成一次章节问答后，记忆会自动保存到当前知识库。")}</Text>
            </div>
          ) : (
            <div className="wiki-ai-memory-list" role="list">
              {memories.map((memory) => (
                <button
                  key={memory.id}
                  type="button"
                  className="wiki-ai-memory-row"
                  role="listitem"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ memory, x: event.clientX, y: event.clientY });
                  }}
                  title={t("右键管理这条记忆")}
                >
                  <span className="wiki-ai-memory-row-icon"><MessageSquareText size={15} /></span>
                  <span className="wiki-ai-memory-row-copy">
                    <strong>{memory.title}</strong>
                    <small>{formatMemoryMeta(memory)}</small>
                  </span>
                  {memory.pinned ? <Pin className="wiki-ai-memory-row-pin" size={13} aria-label={t("已置顶")} /> : null}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </Stack>

      <Menu
        opened={Boolean(contextMenu)}
        onChange={(nextOpened) => { if (!nextOpened) setContextMenu(null); }}
        position="right-start"
        shadow="md"
        width={168}
        withinPortal
      >
        <Menu.Target>
          <span
            className="wiki-ai-memory-context-anchor"
            style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
            aria-hidden="true"
          />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            disabled={saving}
            leftSection={contextMenu?.memory.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            onClick={() => contextMenu && void togglePinned(contextMenu.memory)}
          >
            {contextMenu?.memory.pinned ? t("取消置顶") : t("置顶")}
          </Menu.Item>
          <Menu.Item leftSection={<Pencil size={14} />} onClick={() => {
            if (!contextMenu) return;
            setRenameTarget(contextMenu.memory);
            setRenameTitle(contextMenu.memory.title);
            setActionError(null);
            setContextMenu(null);
          }}>{t("重命名")}</Menu.Item>
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => {
            if (!contextMenu) return;
            setDeleteTarget(contextMenu.memory);
            setActionError(null);
            setContextMenu(null);
          }}>{t("删除")}</Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={Boolean(renameTarget)} onClose={() => !saving && setRenameTarget(null)} title={t("重命名会话")} centered size="sm">
        <TextInput
          label={t("会话名称")}
          value={renameTitle}
          maxLength={120}
          autoFocus
          onChange={(event) => setRenameTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveRename();
          }}
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="gray" disabled={saving} onClick={() => setRenameTarget(null)}>{t("取消")}</Button>
          <Button disabled={saving || !renameTitle.trim()} loading={saving} onClick={() => void saveRename()}>{t("保存")}</Button>
        </Group>
      </Modal>

      <Modal opened={Boolean(deleteTarget)} onClose={() => !saving && setDeleteTarget(null)} title={t("删除会话")} centered size="sm">
        <Text size="sm">{t("将删除“")}{deleteTarget?.title}{t("”中的全部问答记录，不会删除章节或原始资料。此操作无法撤销。")}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="gray" disabled={saving} onClick={() => setDeleteTarget(null)}>{t("取消")}</Button>
          <Button color="red" loading={saving} onClick={() => void confirmDelete()}>{t("删除")}</Button>
        </Group>
      </Modal>
    </Drawer>
  );
}

function formatMemoryMeta(memory: WikiAiMemory): string {
  const rounds = Math.ceil(memory.conversation.length / 2);
  const countLabel = rounds > 0 ? `${rounds} 轮问答` : t("新对话");
  return `${countLabel} · ${new Date(memory.updatedAt).toLocaleString(getAppLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}
