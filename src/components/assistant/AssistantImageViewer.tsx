import { t, useI18n } from '../../i18n';
import { useState } from 'react';
import { ActionIcon, Box, Group, Image, Modal, Text, Tooltip } from '@mantine/core';
import { Minus, Plus } from 'lucide-react';
import type { AssistantAttachment } from '../../electron';

export type AssistantImageAttachment = Extract<AssistantAttachment, { kind: 'image' }>;

interface AssistantImageViewerProps {
  image: AssistantImageAttachment | null;
  onClose: () => void;
}

const minPreviewScale = 0.5;
const maxPreviewScale = 2;
const previewScaleStep = 0.25;

/** 图片附件共用的大图查看器：待发送缩略图和已发送消息保持同一套预览交互。 */
export function AssistantImageViewer({ image, onClose }: AssistantImageViewerProps) {
  useI18n();
  const [previewScale, setPreviewScale] = useState(1);

  const closePreview = () => {
    setPreviewScale(1);
    onClose();
  };
  const adjustPreviewScale = (delta: number) => {
    setPreviewScale((current) => Math.min(maxPreviewScale, Math.max(minPreviewScale, current + delta)));
  };

  return (
    <Modal
      opened={Boolean(image)}
      onClose={closePreview}
      title={image?.name ?? t("图片预览")}
      fullScreen
      overlayProps={{ backgroundOpacity: 0.88, blur: 2 }}
      closeButtonProps={{ 'aria-label': t("关闭图片预览"), title: t("关闭") }}
      transitionProps={{ transition: 'fade', duration: 160 }}
      classNames={{
        content: 'assistant-image-viewer-content',
        header: 'assistant-image-viewer-header',
        title: 'assistant-image-viewer-title',
        close: 'assistant-image-viewer-close',
        body: 'assistant-image-viewer-body',
      }}
    >
      {image ? (
        <Box className="assistant-image-viewer-viewport">
          <Image
            className="assistant-image-viewer-image"
            src={image.dataUrl}
            alt={image.name}
            fit="contain"
            style={{ transform: `scale(${previewScale})` }}
          />
        </Box>
      ) : null}
      <Group className="assistant-image-viewer-controls" gap={5} wrap="nowrap">
        <Tooltip label={t("缩小")} withinPortal>
          <ActionIcon
            variant="subtle"
            color="gray"
            radius="xl"
            aria-label={t("缩小图片")}
            disabled={previewScale <= minPreviewScale}
            onClick={() => adjustPreviewScale(-previewScaleStep)}
          >
            <Minus size={15} />
          </ActionIcon>
        </Tooltip>
        <Text size="xs" aria-live="polite">{Math.round(previewScale * 100)}%</Text>
        <Tooltip label={t("放大")} withinPortal>
          <ActionIcon
            variant="subtle"
            color="gray"
            radius="xl"
            aria-label={t("放大图片")}
            disabled={previewScale >= maxPreviewScale}
            onClick={() => adjustPreviewScale(previewScaleStep)}
          >
            <Plus size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Modal>
  );
}
