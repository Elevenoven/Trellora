import { t, useI18n } from '../../i18n';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Popover,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { Copy, RotateCcw, Sparkles, X } from 'lucide-react';
import ExpansionReceipt from './ExpansionReceipt';
import MarkdownContent from '../MarkdownContent';
import type { SelectionContextReceipt, SelectionEditQualityReceipt } from '../../../electron/knowledge/selectionEditTypes';

interface SelectionEditSuggestionProps {
  position: CSSProperties;
  selectedText: string;
  suggestion: string;
  markdown?: boolean;
  selectedMarkdown?: string;
  stale: boolean;
  contextReceipt?: SelectionContextReceipt;
  qualityReceipt?: SelectionEditQualityReceipt;
  replaceDisabledMessage?: string;
  applyDisabledMessage?: string;
  onClose: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onInsertBelow: () => void;
  onReplace: () => void;
  onPreserveSelection: (event: ReactMouseEvent<HTMLElement>) => void;
}

export default function SelectionEditSuggestion({
  position,
  selectedText,
  suggestion,
  markdown = false,
  selectedMarkdown,
  stale,
  contextReceipt,
  qualityReceipt,
  replaceDisabledMessage,
  applyDisabledMessage,
  onClose,
  onCopy,
  onRegenerate,
  onInsertBelow,
  onReplace,
  onPreserveSelection,
}: SelectionEditSuggestionProps) {
  useI18n();
  const compactViewport = useMediaQuery('(max-width: 520px)');
  const content = (
    <Stack gap="sm" p="sm">
      <Group justify="space-between" wrap="nowrap">
        <Group gap={6} wrap="nowrap"><Sparkles size={16} aria-hidden /><Text size="sm" fw={650}>{t("AI 编辑建议")}</Text></Group>
        <ActionIcon variant="subtle" color="gray" aria-label={t("关闭 AI 编辑建议")} onMouseDown={onPreserveSelection} onClick={onClose}><X size={16} /></ActionIcon>
      </Group>

      {stale ? <Alert color="red" variant="light">{t("原文已变化，不能直接替换。你仍可复制建议或重新生成。")}</Alert> : applyDisabledMessage ?? replaceDisabledMessage ? <Alert color="yellow" variant="light">{applyDisabledMessage ?? replaceDisabledMessage}</Alert> : <Text size="xs" c="dimmed">{t("建议尚未写入笔记，请确认后应用。")}</Text>}

      <ExpansionReceipt context={contextReceipt} quality={qualityReceipt} />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <Paper withBorder radius="sm" p="xs" mah={190} style={{ overflowY: 'auto' }}>
          <Text size="xs" fw={650} c="dimmed">{t("原文")}</Text>
          {markdown ? <MarkdownContent className="assistant-markdown-content" content={selectedMarkdown || selectedText} disableApplicationLinks /> : <Text size="sm" mt={5} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{selectedText}</Text>}
        </Paper>
        <Paper withBorder radius="sm" p="xs" mah={190} style={{ overflowY: 'auto' }}>
          <Text size="xs" fw={650} c="dimmed">{t("建议")}</Text>
          {markdown ? <MarkdownContent className="assistant-markdown-content" content={suggestion} disableApplicationLinks showCodeCopyActions /> : <Text size="sm" mt={5} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{suggestion}</Text>}
        </Paper>
      </SimpleGrid>

      <Group justify="flex-end" gap="xs">
        <Button variant="subtle" size="compact-sm" leftSection={<Copy size={14} />} onMouseDown={onPreserveSelection} onClick={onCopy}>{t("复制结果")}</Button>
        <Button variant="default" size="compact-sm" leftSection={<RotateCcw size={14} />} onMouseDown={onPreserveSelection} onClick={onRegenerate}>{t("重新生成")}</Button>
        {!stale ? <>
          {applyDisabledMessage ? <Tooltip label={applyDisabledMessage} withArrow withinPortal zIndex={1600} position="top"><span><Button size="compact-sm" variant="light" disabled>{t("插入下方")}</Button></span></Tooltip> : <Button size="compact-sm" variant="light" onMouseDown={onPreserveSelection} onClick={onInsertBelow}>{t("插入下方")}</Button>}
          {applyDisabledMessage || replaceDisabledMessage ? <Tooltip label={applyDisabledMessage ?? replaceDisabledMessage} withArrow withinPortal zIndex={1600} position="top"><span><Button size="compact-sm" disabled>{t("替换选区")}</Button></span></Tooltip> : <Button size="compact-sm" onMouseDown={onPreserveSelection} onClick={onReplace}>{t("替换选区")}</Button>}
        </> : null}
      </Group>
    </Stack>
  );

  if (compactViewport) {
    return <Modal opened onClose={onClose} withCloseButton={false} centered size="calc(100vw - 16px)" padding={0} radius="md">{content}</Modal>;
  }

  return (
    <Box aria-hidden style={{ position: 'fixed', left: position.left, top: position.top, width: 1, height: 1, zIndex: 1500 }}>
      <Popover opened position="bottom-start" offset={8} withinPortal zIndex={1550} shadow="md" radius="md" trapFocus={false} returnFocus={false} closeOnEscape onClose={onClose}>
        <Popover.Target><Box component="span" style={{ display: 'block', width: 1, height: 1 }} /></Popover.Target>
        <Popover.Dropdown p={0} style={{ width: 'min(440px, calc(100vw - 16px))', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}>{content}</Popover.Dropdown>
      </Popover>
    </Box>
  );
}
