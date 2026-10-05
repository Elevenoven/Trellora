import { t, useI18n } from '../../i18n';
import { Button, Group, Modal, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { WikiMapNode } from '../../wiki/wikiTypes';

export type WikiNodeAction = 'add' | 'rename' | 'delete';

interface WikiNodeActionModalProps {
  action: WikiNodeAction | null;
  node: WikiMapNode | null;
  onClose: () => void;
  onConfirm: (value: string) => void;
}

export default function WikiNodeActionModal({ action, node, onClose, onConfirm }: WikiNodeActionModalProps) {
  useI18n();
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(action === 'rename' ? node?.title ?? '' : '');
  }, [action, node]);

  const title = action === 'add' ? t("添加派生子节点") : action === 'rename' ? t("重命名派生节点") : t("删除派生节点");
  return (
    <Modal opened={Boolean(action && node)} onClose={onClose} title={title} centered size="sm">
      {action === 'delete' ? (
        <Text size="sm">{t("将删除“")}{node?.title}{t("”及其派生子节点，并同步到本地派生节点记录（不修改原始文档）。")}</Text>
      ) : (
        <TextInput
          label={action === 'add' ? t("节点标题") : t("新标题")}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          autoFocus
          maxLength={80}
          onKeyDown={(event) => event.key === 'Enter' && value.trim() && onConfirm(value.trim())}
        />
      )}
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>{t("取消")}</Button>
        <Button color={action === 'delete' ? 'red' : 'teal'} disabled={action !== 'delete' && !value.trim()} onClick={() => onConfirm(value.trim())}>
          {action === 'delete' ? t("确认删除") : t("确认")}
        </Button>
      </Group>
    </Modal>
  );
}
