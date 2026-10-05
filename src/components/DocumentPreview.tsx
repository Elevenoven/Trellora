import { t, useI18n } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Alert, Box, Button, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { AlertCircle, Palette } from 'lucide-react';
// Electron 31 ships Chromium 126, while PDF.js 6's modern build expects newer
// typed-array APIs (for example Uint8Array.prototype.toHex). Use the official
// polyfilled build so the display layer and its worker stay runtime-compatible.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { renderAsync } from 'docx-preview';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfPageColorMode = 'original' | 'eye-care';

const ORIGINAL_PDF_BACKGROUND = '#ffffff';
const EYE_CARE_PDF_COLORS = {
  background: '#d6dfce',
  foreground: '#293029',
};

interface DocumentPreviewProps {
  extension: string;
  data: Uint8Array;
}

export default function DocumentPreview({ extension, data }: DocumentPreviewProps) {
  useI18n();
  if (extension === '.pdf') {
    return <PdfPreview data={data} />;
  }
  if (extension === '.docx') {
    return <DocxPreview data={data} />;
  }
  return (
    <Alert icon={<AlertCircle size={16} />} color="gray" title={t("暂不支持此格式")}>
      {t("当前预览器支持 PDF 和 DOCX。旧版 .doc 文件可以继续保存和索引，但需要先转换为 .docx 才能在这里查看。")}
    </Alert>
  );
}

function PdfPreview({ data }: { data: Uint8Array }) {
  useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isDarkTheme = useDocumentDarkTheme();
  const hasManualColorMode = useRef(false);
  const [pageColorMode, setPageColorMode] = useState<PdfPageColorMode>(getDefaultPdfPageColorMode);
  const isEyeCareMode = pageColorMode === 'eye-care';
  const pageBackground = isEyeCareMode ? EYE_CARE_PDF_COLORS.background : ORIGINAL_PDF_BACKGROUND;
  const pageColors = useMemo(() => isEyeCareMode ? EYE_CARE_PDF_COLORS : undefined, [isEyeCareMode]);

  useEffect(() => {
    if (!hasManualColorMode.current) setPageColorMode(isDarkTheme ? 'eye-care' : 'original');
  }, [isDarkTheme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => setContainerWidth(Math.round(container.clientWidth));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setPdf(null);
    setIsLoading(true);
    setError(null);
    setPageCount(null);
    setRenderedPages(new Set());

    const loadPdf = async () => {
      try {
        loadingTask = getDocument({ data: data.slice() });
        const loadedPdf = await withTimeout(loadingTask.promise, 20_000, 'PDF 引擎启动超时，请重试或检查文件是否损坏。');
        if (cancelled) return;
        setPdf(loadedPdf);
        setPageCount(loadedPdf.numPages);
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : 'PDF 文件无法打开。');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void loadPdf();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
    };
  }, [data]);

  const markPageRendered = useCallback((pageNumber: number) => {
    setRenderedPages((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  const documentFingerprint = pdf?.fingerprints[0] ?? 'pdf';
  const togglePageColorMode = () => {
    hasManualColorMode.current = true;
    setPageColorMode((current) => current === 'eye-care' ? 'original' : 'eye-care');
  };
  const nextPageColorModeLabel = isEyeCareMode ? '切换为原色预览' : '切换为护眼绿预览';

  return (
    <Stack
      gap="sm"
      className="materials-pdf-preview"
      data-page-color-mode={pageColorMode}
      aria-label={t("PDF 预览")}
    >
      {isLoading ? (
        <div className="materials-document-loading" role="status"><Loader size="sm" color="brand" /><Text size="xs" c="dimmed">{t("正在打开 PDF")}{pageCount ? t(" · {0} 页", { '0': pageCount }) : ''}…</Text></div>
      ) : null}
      {error ? <Alert icon={<AlertCircle size={16} />} color="red" title={t("PDF 预览失败")}>{error}</Alert> : null}
      <Box pos="relative" mih={28}>
        {!isLoading && pdf && pageCount ? (
          <Text size="xs" c="dimmed" ta="center" role="status">
            {t("共")} {pageCount} {t("页 · 已加载")} {renderedPages.size} {t("页 · 向下滚动时继续加载")}
          </Text>
        ) : null}
        <Tooltip label={nextPageColorModeLabel} withArrow>
          <Button
            size="compact-xs"
            variant="light"
            color={isEyeCareMode ? 'green' : 'gray'}
            leftSection={<Palette size={13} />}
            pos="absolute"
            top={0}
            right={0}
            aria-label={nextPageColorModeLabel}
            aria-pressed={isEyeCareMode}
            onClick={togglePageColorMode}
          >
            {isEyeCareMode ? t("护眼绿") : t("原色")}
          </Button>
        </Tooltip>
      </Box>
      <div ref={containerRef} className="materials-pdf-pages">
        {pdf && pageCount && containerWidth > 0
          ? Array.from({ length: pageCount }, (_, index) => {
              const pageNumber = index + 1;
              return (
                <LazyPdfPage
                  key={`${documentFingerprint}-${pageNumber}`}
                  pdf={pdf}
                  pageNumber={pageNumber}
                  containerWidth={containerWidth}
                  pageBackground={pageBackground}
                  pageColors={pageColors}
                  eager={pageNumber === 1}
                  onRendered={markPageRendered}
                />
              );
            })
          : null}
      </div>
    </Stack>
  );
}

function LazyPdfPage({ pdf, pageNumber, containerWidth, pageBackground, pageColors, eager, onRendered }: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  containerWidth: number;
  pageBackground: string;
  pageColors: typeof EYE_CARE_PDF_COLORS | undefined;
  eager: boolean;
  onRendered: (pageNumber: number) => void;
}) {
  useI18n();
  const pageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shouldRender, setShouldRender] = useState(eager);
  const [status, setStatus] = useState<'waiting' | 'loading' | 'ready' | 'error'>(eager ? 'loading' : 'waiting');
  const [aspectRatio, setAspectRatio] = useState(1.414);
  const [error, setError] = useState<string | null>(null);
  const availableWidth = pdfPageWidth(containerWidth);

  useEffect(() => {
    if (shouldRender) return;
    const pageElement = pageRef.current;
    if (!pageElement || typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return;
    }
    const scrollRoot = pageElement.closest('.materials-doc-content');
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldRender(true);
      observer.disconnect();
    }, {
      root: scrollRoot,
      rootMargin: '720px 0px',
      threshold: 0.01,
    });
    observer.observe(pageElement);
    return () => observer.disconnect();
  }, [shouldRender]);

  useEffect(() => {
    if (!shouldRender) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    setStatus('loading');
    setError(null);

    const renderPage = async () => {
      try {
        page = await withTimeout(pdf.getPage(pageNumber), 15_000, `第 ${pageNumber} 页读取超时。`);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.75, Math.min(1.65, availableWidth / baseViewport.width));
        const viewport = page.getViewport({ scale });
        const outputScale = window.devicePixelRatio || 1;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('当前窗口无法创建 PDF 画布。');

        setAspectRatio(viewport.height / viewport.width);
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.setAttribute('aria-label', `PDF 第 ${pageNumber} 页`);

        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          background: pageBackground,
          pageColors,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await withTimeout(renderTask.promise, 30_000, `第 ${pageNumber} 页渲染超时。`);
        if (cancelled) return;
        setStatus('ready');
        onRendered(pageNumber);
      } catch (renderError) {
        if (cancelled) return;
        renderTask?.cancel();
        setStatus('error');
        setError(renderError instanceof Error ? renderError.message : `第 ${pageNumber} 页无法显示。`);
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [availableWidth, onRendered, pageBackground, pageColors, pageNumber, pdf, shouldRender]);

  return (
    <section
      ref={pageRef}
      className="materials-pdf-page"
      data-page-number={pageNumber}
      data-status={status}
      aria-busy={status === 'loading'}
      style={{
        width: availableWidth,
        minHeight: Math.round(availableWidth * aspectRatio),
        '--materials-pdf-page-background': pageBackground,
      } as CSSProperties}
    >
      <canvas ref={canvasRef} hidden={status === 'waiting' || status === 'error'} />
      {status === 'waiting' ? <Text size="xs" c="dimmed">{t("第")} {pageNumber} {t("页 · 滚动到附近时加载")}</Text> : null}
      {status === 'loading' ? <div className="materials-pdf-page-loading"><Loader size="sm" color="brand" /><Text size="xs" c="dimmed">{t("正在加载第")} {pageNumber} {t("页…")}</Text></div> : null}
      {status === 'error' ? <Alert icon={<AlertCircle size={16} />} color="red" title={t("第 {0} 页加载失败", { '0': pageNumber })}>{error}</Alert> : null}
    </section>
  );
}

function pdfPageWidth(containerWidth: number): number {
  return Math.max(320, Math.min(960, containerWidth - 36));
}

function useDocumentDarkTheme(): boolean {
  const [isDarkTheme, setIsDarkTheme] = useState(readDocumentDarkTheme);

  useEffect(() => {
    const root = document.documentElement;
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => setIsDarkTheme(readDocumentDarkTheme());
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    colorScheme.addEventListener('change', updateTheme);
    return () => {
      observer.disconnect();
      colorScheme.removeEventListener('change', updateTheme);
    };
  }, []);

  return isDarkTheme;
}

function getDefaultPdfPageColorMode(): PdfPageColorMode {
  return readDocumentDarkTheme() ? 'eye-care' : 'original';
}

function readDocumentDarkTheme(): boolean {
  const configuredTheme = document.documentElement.dataset.theme;
  if (configuredTheme === 'dark') return true;
  if (configuredTheme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timeoutId);
        reject(reason);
      },
    );
  });
}

function DocxPreview({ data }: { data: Uint8Array }) {
  useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const renderContainer = document.createElement('div');
    renderContainer.className = 'materials-docx-render-root';
    container.replaceChildren(renderContainer);
    setIsLoading(true);
    setError(null);

    void renderAsync(data, renderContainer, renderContainer, {
      className: 'docx',
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: true,
      renderAltChunks: false,
    })
      .catch((renderError: unknown) => {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : 'Word 文件无法打开。');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [data]);

  return (
    <Stack gap="sm" className="materials-docx-preview" aria-label={t("Word 预览")}>
      {isLoading ? <div className="materials-document-loading" role="status"><Loader size="sm" color="brand" /><Text size="xs" c="dimmed">{t("正在排版 Word 文档…")}</Text></div> : null}
      {error ? <Alert icon={<AlertCircle size={16} />} color="red" title={t("Word 预览失败")}>{error}</Alert> : null}
      <div ref={containerRef} className="materials-docx-surface" />
    </Stack>
  );
}
