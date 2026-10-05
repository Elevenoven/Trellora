import { t, useI18n } from '../../i18n';
import { useState } from 'react';
import { ActionIcon, Box, Group, Image, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { FileText, X } from 'lucide-react';
import type { AssistantAttachment } from '../../electron';
import { AssistantImageViewer, type AssistantImageAttachment } from './AssistantImageViewer';
import { formatAssistantAttachmentBytes } from './assistantAttachmentPresentation';

interface AssistantComposerAttachmentsProps {
  attachments: AssistantAttachment[];
  onRemove: (attachmentId: string) => void;
  disabled?: boolean;
}

/**
 * Composer 上方的本轮附件 Chip 条（开发方案 §7.1，按项目规范以 Mantine 组件实现，不使用原生 HTML 控件）。
 * 图片附件渲染 dataUrl 缩略图；文档 / 文本附件渲染文件图标。每个 Chip 提供移除动作。
 */
export function AssistantComposerAttachments({ attachments, onRemove, disabled }: AssistantComposerAttachmentsProps) {
  useI18n();
  const [previewImage, setPreviewImage] = useState<AssistantImageAttachment | null>(null);

  if (!attachments.length) return null;
  return <>
    <Group className="assistant-composer-attachments" gap={6} wrap="wrap" role="list" aria-label={t("本轮附件")}>
      {attachments.map((attachment) => (
        <Group
          key={attachment.attachmentId}
          className={`assistant-attachment-chip${attachment.kind === 'image' ? ' image-only' : ''}`}
          gap={attachment.kind === 'image' ? 0 : 6}
          wrap="nowrap"
          role="listitem"
          aria-label={t("附件 {0}", { '0': attachment.name })}
        >
          {attachment.kind === 'image' ? (
            <UnstyledButton
              className="assistant-attachment-preview"
              onClick={() => setPreviewImage(attachment)}
              aria-label={t("查看图片 {0}", { '0': attachment.name })}
              title={t("查看大图：{0}", { '0': attachment.name })}
            >
              <Image
                className="assistant-attachment-thumb"
                src={attachment.dataUrl}
                alt={attachment.name}
                width={112}
                height={70}
                radius="sm"
                fit="cover"
              />
            </UnstyledButton>
          ) : (
            <>
              <Box className="assistant-attachment-icon" aria-hidden="true">
                <FileText size={15} />
              </Box>
              <Box className="assistant-attachment-meta">
                <Text className="assistant-attachment-name" size="xs" fw={500} lineClamp={1} title={attachment.name}>
                  {attachment.name}
                </Text>
                <Text className="assistant-attachment-size" size="xs" c="dimmed">
                  {formatAssistantAttachmentBytes(attachment.sizeBytes)}
                </Text>
              </Box>
            </>
          )}
          <Tooltip label={t("移除附件 {0}", { '0': attachment.name })} withinPortal>
            <ActionIcon
              className="assistant-attachment-remove"
              size="xs"
              variant="subtle"
              color="red"
              radius="xl"
              disabled={disabled}
              onClick={() => onRemove(attachment.attachmentId)}
              aria-label={t("移除附件 {0}", { '0': attachment.name })}
            >
              <X size={12} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ))}
    </Group>
    <AssistantImageViewer image={previewImage} onClose={() => setPreviewImage(null)} />
  </>;
}
