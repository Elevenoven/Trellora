import { t, useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { Alert, Button, Code, Group, Modal, Paper, Stack, Text, TextInput } from '@mantine/core';
import { AlertTriangle, FolderOpen, Plus, X } from 'lucide-react';

interface CreateLibraryModalProps {
  opened: boolean;
  workspacePath: string | null;
  onClose: () => void;
  onSelectDirectory: () => Promise<string | null>;
  onCreate: (name: string, parentDirectoryPath: string | null) => Promise<void>;
}

export default function CreateLibraryModal({
  opened,
  workspacePath,
  onClose,
  onSelectDirectory,
  onCreate,
}: CreateLibraryModalProps) {
  useI18n();
  const [name, setName] = useState('');
  const [parentDirectoryPath, setParentDirectoryPath] = useState<string | null>(null);
  const [isSelectingDirectory, setIsSelectingDirectory] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setName('');
    setParentDirectoryPath(null);
    setError(null);
  }, [opened]);

  const chooseDirectory = async () => {
    setIsSelectingDirectory(true);
    setError(null);
    try {
      const selectedPath = await onSelectDirectory();
      if (selectedPath) setParentDirectoryPath(selectedPath);
    } catch (selectionError) {
      setError(toMessage(selectionError, t("选择存放位置失败。")));
    } finally {
      setIsSelectingDirectory(false);
    }
  };

  const createLibrary = async () => {
    if (!name.trim()) {
      setError(t("请输入笔记库名称。"));
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      await onCreate(name.trim(), parentDirectoryPath);
    } catch (createError) {
      setError(toMessage(createError, t("创建笔记库失败。")));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t("新建笔记库")} centered size="md">
      <Stack gap="lg">
        <Text size="sm" c="dimmed">
          {t("笔记库会拥有自己的文件夹，笔记、附件、备份和索引都会存放在其中。")}
        </Text>

        <TextInput
          label={t("笔记库名称")}
          placeholder={t("例如：产品阅读")}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          autoFocus
          required
        />

        <Paper withBorder radius="md" p="md">
          <Stack gap="xs">
            <Text size="sm" fw={650}>{t("存放位置（可选）")}</Text>
            <Text size="xs" c="dimmed">
              {t("不指定时，系统会在工作区内创建“名称-时间戳”文件夹；指定后，会在所选文件夹下使用笔记库名称创建目录。")}
            </Text>
            <Code block className="create-library-path">
              {parentDirectoryPath ?? workspacePath ?? t("工作区尚未设置")}
            </Code>
            <Group gap="xs">
              <Button variant="light" leftSection={<FolderOpen size={15} />} loading={isSelectingDirectory} onClick={() => void chooseDirectory()}>
                {t("选择指定文件夹")}
              </Button>
              {parentDirectoryPath ? <Button variant="subtle" color="gray" leftSection={<X size={15} />} onClick={() => setParentDirectoryPath(null)}>{t("使用系统工作区")}</Button> : null}
            </Group>
          </Stack>
        </Paper>

        {error ? <Alert color="red" variant="light" icon={<AlertTriangle size={16} />}>{error}</Alert> : null}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>{t("取消")}</Button>
          <Button leftSection={<Plus size={16} />} loading={isCreating} onClick={() => void createLibrary()}>{t("创建笔记库")}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
