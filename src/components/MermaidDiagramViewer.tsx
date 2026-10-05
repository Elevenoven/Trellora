import { t, useI18n } from '../i18n';
import { Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface MermaidDiagramViewerProps {
  svg: string;
  onClose: () => void;
}

interface DiagramSize {
  width: number;
  height: number;
}

const minZoom = 0.25;
const maxZoom = 4;
const zoomStep = 0.25;

function getDiagramSize(svg: SVGSVGElement): DiagramSize | null {
  const viewBox = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  const width = Number.parseFloat(svg.getAttribute('width') ?? '');
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }
  return null;
}

export default function MermaidDiagramViewer({ svg, onClose }: MermaidDiagramViewerProps) {
  useI18n();
  const captionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [fitToWindow, setFitToWindow] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [diagramSize, setDiagramSize] = useState<DiagramSize | null>(null);
  const updateZoom = useCallback((delta: number) => {
    setFitToWindow(false);
    setZoom(current => Math.min(maxZoom, Math.max(minZoom, current + delta)));
  }, []);

  useEffect(() => {
    setFitToWindow(true);
    setZoom(1);
    const renderedSvg = canvasRef.current?.querySelector<SVGSVGElement>('svg');
    setDiagramSize(renderedSvg ? getDiagramSize(renderedSvg) : null);
  }, [svg]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
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
      if (event.ctrlKey || event.metaKey || event.altKey) return;
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

  const manualSize = !fitToWindow && diagramSize
    ? { width: diagramSize.width * zoom, height: diagramSize.height * zoom }
    : undefined;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="mermaid-diagram-viewer"
      aria-label={t("Mermaid 图表查看器")}
      aria-describedby={captionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mermaid-diagram-viewer-shell">
        <div className="mermaid-diagram-viewer-toolbar" role="toolbar" aria-label={t("Mermaid 图表缩放工具")}>
          <button
            type="button"
            className="mermaid-diagram-viewer-icon-button"
            aria-label={t("缩小图表")}
            title={t("缩小")}
            disabled={!fitToWindow && zoom <= minZoom}
            onClick={() => updateZoom(-zoomStep)}
          >
            <ZoomOut size={18} aria-hidden="true" />
          </button>
          <output className="mermaid-diagram-viewer-scale" aria-live="polite">
            {fitToWindow ? t("适应") : `${Math.round(zoom * 100)}%`}
          </output>
          <button
            type="button"
            className="mermaid-diagram-viewer-icon-button"
            aria-label={t("放大图表")}
            title={t("放大")}
            disabled={!fitToWindow && zoom >= maxZoom}
            onClick={() => updateZoom(zoomStep)}
          >
            <ZoomIn size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mermaid-diagram-viewer-icon-button"
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
          <span className="mermaid-diagram-viewer-toolbar-spacer" />
          <button
            ref={closeButtonRef}
            type="button"
            className="mermaid-diagram-viewer-icon-button"
            aria-label={t("关闭 Mermaid 图表查看器")}
            title={t("关闭")}
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <figure className="mermaid-diagram-viewer-figure">
          <div
            ref={canvasRef}
            className="mermaid-diagram-viewer-canvas"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            <div
              className="mermaid-diagram-viewer-svg"
              data-fit={fitToWindow ? 'true' : 'false'}
              style={manualSize}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          <figcaption id={captionId}>{t("Mermaid 图表")}</figcaption>
        </figure>
      </div>
    </dialog>,
    document.body,
  );
}
