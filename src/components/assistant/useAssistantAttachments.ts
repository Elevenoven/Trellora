import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type { AssistantAttachment } from '../../electron';
import { relocateWorkspacePath, type WorkspaceDataChange } from '../../utils/workspaceDataEvents';

// 镜像 electron/knowledge/assistantTurnTypes.ts 的 Phase 1 常量。
// 渲染进程不直接引入主进程模块，避免把校验逻辑打进浏览器 bundle；如需调整上限/大小请双侧同步。
const MAX_IMAGE_BYTES = 5_000_000;
const DEFAULT_MAX_ATTACHMENTS = 6;

// 与 assistantTurnTypes.assistantImageMimeTypes 白名单保持一致。
type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
const IMAGE_MIME_WHITELIST: readonly ImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function normalizeImageMimeType(raw: string): ImageMimeType | null {
  const lower = raw.toLowerCase();
  return IMAGE_MIME_WHITELIST.find((mime) => mime === lower) ?? null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败。'));
    reader.readAsDataURL(file);
  });
}

// 内容寻址 id：与主进程 select-assistant-attachments 的 `image-${sha256(dataUrl).slice(0, 24)}` 对齐，
// 使「粘贴 / 拖拽」与「文件选择」加入的同一张图去重到同一 attachmentId。
// crypto.subtle 仅在安全上下文可用（dev 的 http://localhost 可用，生产 file:// 可能缺失），缺失时降级为同步哈希。
async function computeImageAttachmentId(dataUrl: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `image-${hex.slice(0, 24)}`;
  }
  return `image-${fallbackContentHash(dataUrl)}`;
}

// 双 32-bit 变体哈希 + 长度，base36 编码并补齐到 24 位；满足 readId 正则 ^[A-Za-z][A-Za-z0-9_-]{7,96}$，
// 单轮最多 6 个附件下碰撞概率可忽略。
function fallbackContentHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = ((h1 ^ code) * 0x01000193) >>> 0;
    h2 = (h2 + code + index) >>> 0;
    h2 = (h2 ^ (h2 >>> 7)) >>> 0;
  }
  const raw = `${h1.toString(36)}${h2.toString(36)}${input.length.toString(36)}`;
  return raw.padEnd(24, '0').slice(0, 24);
}

export interface UseAssistantAttachmentsOptions {
  /** 单轮附件数量上限，默认与主进程 maxAssistantAttachmentCount 一致（6）。 */
  maxCount?: number;
  /** 请求进行中或整理意图等场景下禁用粘贴 / 拖拽。 */
  disabled?: boolean;
}

export interface UseAssistantAttachmentsResult {
  attachments: AssistantAttachment[];
  isDragActive: boolean;
  addAttachments: (incoming: AssistantAttachment[]) => void;
  removeAttachment: (attachmentId: string) => void;
  clearAttachments: () => void;
  handlePaste: (event: ClipboardEvent) => void;
  handleDrop: (event: DragEvent) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDragEnter: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
}

/**
 * 多模态问答助手短期附件管理（开发方案 §7.2）。
 * 图片由渲染进程用 FileReader 生成 dataUrl；拖入的文本 / 文档经 preload 的 webUtils
 * 解析本地路径，再交主进程按与文件选择器相同的白名单和大小限制构造附件。
 */
export function useAssistantAttachments(options: UseAssistantAttachmentsOptions = {}): UseAssistantAttachmentsResult {
  const { maxCount = DEFAULT_MAX_ATTACHMENTS, disabled = false } = options;
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const addAttachments = useCallback((incoming: AssistantAttachment[]) => {
    if (!incoming.length) return;
    const merged = [...attachments];
    let rejected = 0;
    for (const item of incoming) {
      if (merged.length >= maxCount) {
        rejected += 1;
        continue;
      }
      if (merged.some((existing) => existing.attachmentId === item.attachmentId)) continue;
      merged.push(item);
    }
    setAttachments(merged);
    if (rejected > 0) window.alert(`一次最多添加 ${maxCount} 个附件，超出的 ${rejected} 个已忽略。`);
  }, [attachments, maxCount]);

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.attachmentId !== attachmentId));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const createImageAttachments = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.toLowerCase().startsWith('image/'));
    const incoming: AssistantAttachment[] = [];
    for (const file of imageFiles) {
      const displayName = file.name || `粘贴的图片 ${incoming.length + 1}.png`;
      if (file.size > MAX_IMAGE_BYTES) {
        window.alert(`图片「${displayName}」超过 5 MB，已跳过。`);
        continue;
      }
      const mimeType = normalizeImageMimeType(file.type);
      if (!mimeType) {
        window.alert(`图片「${displayName}」格式不受支持（仅 PNG / JPEG / WebP / GIF），已跳过。`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const attachmentId = await computeImageAttachmentId(dataUrl);
        incoming.push({ kind: 'image', attachmentId, name: displayName, mimeType, sizeBytes: file.size, dataUrl });
      } catch (error) {
        window.alert(error instanceof Error ? error.message : `读取图片「${displayName}」失败。`);
      }
    }
    return incoming;
  }, []);

  useEffect(() => {
    const changed = (event: Event) => {
      const { source, target } = (event as CustomEvent<WorkspaceDataChange>).detail;
      if (!source || !target) return;
      setAttachments(current => current.map(attachment => attachment.kind === 'image' ? attachment : { ...attachment, path: relocateWorkspacePath(attachment.path, source, target)! }));
    };
    window.addEventListener('workspace-data-changed', changed);
    return () => window.removeEventListener('workspace-data-changed', changed);
  }, []);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    if (disabled) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind === 'file' && item.type.toLowerCase().startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (!imageFiles.length) return; // 普通文本粘贴不拦截，交回 Textarea 默认行为。
    event.preventDefault();
    void createImageAttachments(imageFiles).then(addAttachments);
  }, [addAttachments, createImageAttachments, disabled]);

  const handleDragEnter = useCallback((event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    dragDepthRef.current += 1;
    setIsDragActive(true);
  }, [disabled]);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, [disabled]);

  const handleDragLeave = useCallback((event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragActive(false);
  }, [disabled]);

  const handleDrop = useCallback((event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    const imageFiles = files.filter((file) => file.type.toLowerCase().startsWith('image/'));
    const localFiles = files.filter((file) => !file.type.toLowerCase().startsWith('image/'));
    void (async () => {
      try {
        const [images, localAttachments] = await Promise.all([
          createImageAttachments(imageFiles),
          localFiles.length
            ? window.electronAPI?.ingestAssistantDroppedFiles(localFiles) ?? Promise.reject(new Error('当前运行环境不支持拖入文档附件。'))
            : Promise.resolve([]),
        ]);
        addAttachments([...images, ...localAttachments]);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : '读取拖入附件失败。');
      }
    })();
  }, [addAttachments, createImageAttachments, disabled]);

  return {
    attachments,
    isDragActive,
    addAttachments,
    removeAttachment,
    clearAttachments,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
  };
}
