import { t, useI18n } from '../../i18n';
import { useState } from 'react';
import { Box, Group, Image, Text, UnstyledButton } from '@mantine/core';
import { FileText } from 'lucide-react';
import type { AssistantAttachment } from '../../electron';
import { AssistantImageViewer, type AssistantImageAttachment } from './AssistantImageViewer';
import { formatAssistantAttachmentBytes } from './assistantAttachmentPresentation';

/**
 * 已发送用户消息的短期附件投影：附件只保留在当前渲染会话中，不进入文字历史或本地记忆。
 * 图片以紧凑缩略图显示并提供灯箱预览；其他附件只展示名称与大小，不暴露本地路径。
 */
export function AssistantMessageAttachments({ attachments }: { attachments: AssistantAttachment[] }) {
  useI18n();
  const [previewImage, setPreviewImage] = useState<AssistantImageAttachment | null>(null);

  if (!attachments.length) return null;

  const openPreview = (attachment: AssistantImageAttachment) => {
    setPreviewImage(attachment);
  };

  return <>
    <Group className="assistant-message-attachments" gap={6} wrap="wrap" role="list" aria-label={t("本轮发送的附件")}>
      {attachments.map((attachment) => attachment.kind === 'image' ? (
        <UnstyledButton
          key={attachment.attachmentId}
          className="assistant-message-image-attachment"
          role="listitem"
          onClick={() => openPreview(attachment)}
          aria-label={t("查看图片 {0}", { '0': attachment.name })}
          title={t("查看图片：{0}", { '0': attachment.name })}
        >
          <Image className="assistant-message-image-thumbnail" src={attachment.dataUrl} alt={attachment.name} fit="cover" />
          <Text className="assistant-message-attachment-name" size="xs" lineClamp={1}>{attachment.name}</Text>
        </UnstyledButton>
      ) : (
        <Group key={attachment.attachmentId} className="assistant-message-file-attachment" gap={7} wrap="nowrap" role="listitem" aria-label={t("附件 {0}", { '0': attachment.name })}>
          <Box className="assistant-message-file-icon" aria-hidden="true"><FileText size={15} /></Box>
          <Box className="assistant-message-file-meta">
            <Text className="assistant-message-attachment-name" size="xs" fw={500} lineClamp={1} title={attachment.name}>{attachment.name}</Text>
            <Text size="xs" c="dimmed">{formatAssistantAttachmentBytes(attachment.sizeBytes)}</Text>
          </Box>
        </Group>
      ))}
    </Group>

    <AssistantImageViewer image={previewImage} onClose={() => setPreviewImage(null)} />
  </>;
}
