import { t, useI18n } from '../../i18n';
import { Alert, Button, Group, Loader, Modal, Select, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { LibrarySummary } from '../../electron';

export interface WikiNoteSource {
  libraryPath: string;
  documentId: string;
  contentHash: string;
  name: string;
}

interface WikiOpenInNotesModalProps {
  source: WikiNoteSource | null;
  onClose: () => void;
  onOpen: (source: WikiNoteSource, targetLibraryPath: string) => Promise<void>;
}

/** 先选择目标笔记库，确认后才创建或打开来源文档对应的笔记。 */
export default function WikiOpenInNotesModal({ source, onClose, onOpen }: WikiOpenInNotesModalProps) {
  useI18n();
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setLibraries([]);
    setTargetPath(null);
    setError(null);
    setLoading(true);
    void window.electronAPI.listLibraries().then((items) => {
      if (cancelled) return;
      const available = items.filter((library) => library.exists);
      setLibraries(available);
      setTargetPath(available.find((library) => library.isActive)?.path ?? available[0]?.path ?? null);
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source]);

  const handleOpen = async () => {
    if (!source || !targetPath || opening) return;
    setOpening(true);
    setError(null);
    try {
      await onOpen(source, targetPath);
      onClose();
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally { setOpening(false); }
  };

  return (
    <Modal opened={Boolean(source)} onClose={() => { if (!opening) onClose(); }} title={t("选择笔记库")} centered size="sm" closeOnClickOutside={!opening} closeOnEscape={!opening} withCloseButton={!opening}>
      <Stack gap="md">
        <Text size="sm" fw={600}>{source?.name}</Text>
        <Text size="xs" c="dimmed">{t("将完整解析正文保存为 Markdown 笔记并打开。已生成的笔记会直接打开，保留你的编辑。")}</Text>
        {loading ? <Group justify="center"><Loader size="sm" /></Group> : (
          <Select label={t("目标笔记库")} placeholder={t("选择笔记库")} data={libraries.map((library) => ({ value: library.path, label: library.alias }))} value={targetPath} onChange={setTargetPath} searchable allowDeselect={false} disabled={opening || libraries.length === 0} comboboxProps={{ withinPortal: false }} />
        )}
        {!loading && libraries.length === 0 && !error ? <Text size="sm" c="dimmed">{t("还没有可用的笔记库，请先在笔记库管理中添加或创建笔记库。")}</Text> : null}
        {error ? <Alert color="red" title={t("无法打开笔记")}>{error}</Alert> : null}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={opening}>{t("取消")}</Button>
          <Button onClick={() => void handleOpen()} loading={opening} disabled={loading || !targetPath}>{t("打开笔记")}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
