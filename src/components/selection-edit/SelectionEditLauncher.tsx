import { getAppLanguage, t, useI18n } from '../../i18n';
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
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { BookOpenText, Sparkles, X } from 'lucide-react';
import type { SelectionEditAction, SelectionEditContextScope } from '../../electron';

interface SelectionEditActionOption {
  action: SelectionEditAction;
  label: string;
  description: string;
}

interface SelectionEditLauncherProps {
  position: CSSProperties;
  selectedCharacters: number;
  nearbyCharacters: number;
  snapshotCurrent: boolean;
  action: SelectionEditAction;
  contextScope: SelectionEditContextScope;
  targetLanguage: string;
  instruction: string;
  generating: boolean;
  error: string | null;
  actions: readonly SelectionEditActionOption[];
  onActionChange: (action: SelectionEditAction) => void;
  onContextScopeChange: (scope: SelectionEditContextScope) => void;
  onTargetLanguageChange: (value: string) => void;
  onInstructionChange: (value: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
  onOpenEvidenceWorkspace?: () => void;
  onPreserveSelection: (event: ReactMouseEvent<HTMLElement>) => void;
}

const contextScopeOptions: Array<{ value: SelectionEditContextScope; label: string; disabled?: boolean }> = [
  { value: 'auto', label: '自动（按动作装配上下文）' },
  { value: 'nearby', label: '仅附近（同段前后文）' },
  { value: 'current-note', label: '当前笔记（受控原文读取）' },
  { value: 'extended', label: '扩展来源（请使用扩写工作区）', disabled: true },
];

export default function SelectionEditLauncher({
  position,
  selectedCharacters,
  nearbyCharacters,
  snapshotCurrent,
  action,
  contextScope,
  targetLanguage,
  instruction,
  generating,
  error,
  actions,
  onActionChange,
  onContextScopeChange,
  onTargetLanguageChange,
  onInstructionChange,
  onGenerate,
  onCancel,
  onOpenEvidenceWorkspace,
  onPreserveSelection,
}: SelectionEditLauncherProps) {
  useI18n();
  const compactViewport = useMediaQuery('(max-width: 520px)');
  const useNearbyContext = contextScope === 'nearby' && snapshotCurrent;
  const receipt = useNearbyContext
    ? `将处理选区，并发送同一文本块前后文共 ${nearbyCharacters} 字。`
    : contextScope === 'current-note'
      ? '将把选区作为编辑对象，并在预算内读取当前笔记的相关原文。'
      : '系统按动作画像装配上下文；精简、扩写和解释会优先读取当前笔记的相关原文。';

  const content = (
    <Stack gap="sm" p="sm" style={{ minHeight: 0, flex: '1 1 auto', overflow: 'hidden' }}>
      <Group justify="space-between" wrap="nowrap" style={{ flexShrink: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Sparkles size={16} aria-hidden />
          <Text size="sm" fw={650}>{t("对所选文字进行编辑")}</Text>
        </Group>
        <ActionIcon variant="subtle" color="gray" aria-label={t("关闭 AI 编辑")} onMouseDown={onPreserveSelection} onClick={onCancel}>
          <X size={16} />
        </ActionIcon>
      </Group>

      {/* Portal 下拉框的点击仍属于面板，不能触发外层 Popover 的点击外部关闭。 */}
      <Box onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <Stack gap="sm">
          <SimpleGrid cols={2} spacing={6}>
            {actions.map((item) => {
              const active = item.action === action;
              return (
                <UnstyledButton
                  key={item.action}
                  aria-pressed={active}
                  onMouseDown={onPreserveSelection}
                  onClick={() => onActionChange(item.action)}
                  style={{
                    minHeight: 58,
                    padding: '8px 9px',
                    border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border-subtle)'}`,
                    borderRadius: 'var(--mantine-radius-sm)',
                    background: active ? 'var(--surface-selected)' : 'transparent',
                    textAlign: 'left',
                  }}
                >
                  <Text size="xs" fw={650}>{item.label}</Text>
                  <Text size="xs" c="dimmed" mt={2} lh={1.35}>{item.description}</Text>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>

          {action === 'translate' ? <TextInput label={t("目标语言")} value={targetLanguage} maxLength={60} placeholder={t("例如：英语")} onChange={(event) => onTargetLanguageChange(event.currentTarget.value)} /> : null}
          {action === 'custom' ? <Textarea label={t("自定义要求")} value={instruction} maxLength={500} autosize minRows={2} maxRows={5} placeholder={t("例如：改成适合周报的正式语气")} onChange={(event) => onInstructionChange(event.currentTarget.value)} /> : null}

          <Select
            label={t("上下文范围")}
            value={contextScope}
            data={contextScopeOptions}
            comboboxProps={{ zIndex: 1600 }}
            onChange={(value) => value && onContextScopeChange(value as SelectionEditContextScope)}
          />

          <Paper withBorder radius="sm" p="xs" style={{ borderLeft: '3px solid var(--mantine-color-teal-6)' }}>
            <Group gap={6} mb={3} wrap="nowrap"><BookOpenText size={14} aria-hidden /><Text size="xs" fw={650}>{t("上下文收据")}</Text></Group>
            <Text size="xs" c="dimmed" lh={1.45}>{receipt}</Text>
            <Text size="xs" c="dimmed" mt={4}>{t("选区")} {selectedCharacters.toLocaleString(getAppLanguage())} {t("字")}</Text>
          </Paper>

          {action === 'expand' && onOpenEvidenceWorkspace ? <Button variant="subtle" size="compact-sm" px={0} justify="flex-start" onMouseDown={onPreserveSelection} onClick={onOpenEvidenceWorkspace}>
            {t("需要当前笔记证据？打开扩写工作区")}
          </Button> : null}

          {!snapshotCurrent ? <Alert color="red" variant="light">{t("原文已变化。本次重新生成只能处理原始选区，结果不能直接替换。")}</Alert> : null}
          {error ? <Alert color="red" variant="light">{error}</Alert> : null}
        </Stack>
      </Box>

      <Group justify="flex-end" pt="xs" style={{ flexShrink: 0, borderTop: '1px solid var(--border-subtle)' }}>
        <Button variant="default" size="sm" onMouseDown={onPreserveSelection} onClick={onCancel}>{t("取消")}</Button>
        <Button size="sm" loading={generating} onMouseDown={onPreserveSelection} onClick={onGenerate}>{t("生成建议")}</Button>
      </Group>
    </Stack>
  );

  if (compactViewport) {
    return <Modal opened onClose={onCancel} withCloseButton={false} centered size="calc(100vw - 16px)" xOffset={8} yOffset={8} padding={0} radius="md"
      styles={{ content: { display: 'flex', flexDirection: 'column', maxHeight: 'calc(100dvh - 16px)', overflow: 'hidden' }, body: { display: 'flex', minHeight: 0, overflow: 'hidden' } }}>
      {content}
    </Modal>;
  }

  return (
    <Box aria-hidden style={{ position: 'fixed', left: position.left, top: position.top, width: 1, height: 1, zIndex: 1500 }}>
      <Popover opened position="bottom-start" offset={8} withinPortal zIndex={1550} shadow="md" radius="md" trapFocus={false} returnFocus={false} closeOnEscape onClose={onCancel}
        // 选项展开后按真实尺寸避让窗口边缘，空间不足时只滚动中间内容。
        middlewares={{ flip: { padding: 8 }, shift: { padding: 8, crossAxis: true, limiter: undefined }, size: { padding: 8 } }}>
        <Popover.Target><Box component="span" style={{ display: 'block', width: 1, height: 1 }} /></Popover.Target>
        <Popover.Dropdown p={0} style={{ width: 'min(360px, calc(100vw - 16px))', maxHeight: 'calc(100dvh - 16px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {content}
        </Popover.Dropdown>
      </Popover>
    </Box>
  );
}
