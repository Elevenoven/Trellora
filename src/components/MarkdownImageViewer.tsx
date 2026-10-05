import { t, useI18n } from '../i18n';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';

export interface MarkdownImageViewerImage {
  src: string;
  alt: string;
}

interface MarkdownImageViewerProps {
  image: MarkdownImageViewerImage;
  onClose: () => void;
}

const minZoom = 0.25;
const maxZoom = 4;
const zoomStep = 0.25;

export default function MarkdownImageViewer({ image, onClose }: MarkdownImageViewerProps) {
  useI18n();
  const captionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [fitToWindow, setFitToWindow] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const updateZoom = useCallback((delta: number) => {
    setFitToWindow(false);
    setZoom((current) => Math.min(maxZoom, Math.max(minZoom, current + delta)));
  }, []);

  useEffect(() => {
    setFitToWindow(true);
    setZoom(1);
    setNaturalSize({ width: 0, height: 0 });
  }, [image.src]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }

    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        updateZoom(zoomStep);
      } else if (event.key === '-') {
        event.preventDefault();
        updateZoom(-zoomStep);
      } else if (event.key === '0') {
        event.preventDefault();
        setFitToWindow(true);
        setZoom(1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose, updateZoom]);
  const renderedWidth = naturalSize.width > 0 ? naturalSize.width * zoom : undefined;
  const renderedHeight = naturalSize.height > 0 ? naturalSize.height * zoom : undefined;
  const altText = image.alt.trim() || '未提供替代文本';

  return createPortal(
    <dialog
      ref={dialogRef}
      className="markdown-image-viewer"
      aria-label={t("图片查看器")}
      aria-describedby={captionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="markdown-image-viewer-shell">
        <div className="markdown-image-viewer-toolbar" role="toolbar" aria-label={t("图片缩放工具")}>
          <button
            type="button"
            className="markdown-image-viewer-icon-button"
            aria-label={t("缩小图片")}
            title={t("缩小")}
            disabled={!fitToWindow && zoom <= minZoom}
            onClick={() => updateZoom(-zoomStep)}
          >
            <ZoomOut size={18} aria-hidden="true" />
          </button>
          <output className="markdown-image-viewer-scale" aria-live="polite">
            {fitToWindow ? t("适应") : `${Math.round(zoom * 100)}%`}
          </output>
          <button
            type="button"
            className="markdown-image-viewer-icon-button"
            aria-label={t("放大图片")}
            title={t("放大")}
            disabled={!fitToWindow && zoom >= maxZoom}
            onClick={() => updateZoom(zoomStep)}
          >
            <ZoomIn size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="markdown-image-viewer-icon-button"
            data-active={fitToWindow ? 'true' : 'false'}
            aria-label={t("适应窗口")}
            aria-pressed={fitToWindow}
            title={t("适应窗口")}
            onClick={() => {
              setFitToWindow(true);
              setZoom(1);
            }}
          >
            <Maximize2 size={18} aria-hidden="true" />
          </button>
          <span className="markdown-image-viewer-toolbar-spacer" />
          <button
            ref={closeButtonRef}
            type="button"
            className="markdown-image-viewer-icon-button"
            aria-label={t("关闭图片查看器")}
            title={t("关闭")}
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <figure className="markdown-image-viewer-figure">
          <div
            className="markdown-image-viewer-canvas"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            <img
              className="markdown-image-viewer-image"
              data-fit={fitToWindow ? 'true' : 'false'}
              src={image.src}
              alt={image.alt}
              draggable={false}
              style={fitToWindow || renderedWidth === undefined
                ? undefined
                : { width: renderedWidth, height: renderedHeight, maxWidth: 'none', maxHeight: 'none' }}
              onLoad={(event) => setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
            />
          </div>
          <figcaption id={captionId}>{altText}</figcaption>
        </figure>
      </div>
    </dialog>,
    document.body,
  );
}
