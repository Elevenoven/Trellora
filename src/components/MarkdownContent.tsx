import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  decodeHeadingFragment,
  scrollToHeadingAnchor,
} from '../utils/headingAnchors';
import { enhanceMarkdownContainer } from '../utils/markdownEnhancements';
import { renderPreviewHtml } from '../utils/preview';
import type { MarkdownFrontmatterMode } from '../utils/markdownExtensions';
import {
  parseRelativeMarkdownLinkHref,
  type MarkdownRelativeLinkTarget,
} from '../utils/markdownLinks';
import { normalizeMarkdownSearchText, type MarkdownAssetContext } from '../utils/markdown';
import type { ResolvedTheme } from '../utils/theme';
import MarkdownImageViewer, { type MarkdownImageViewerImage } from './MarkdownImageViewer';

interface MarkdownContentProps extends MarkdownAssetContext {
  content: string;
  frontmatter?: MarkdownFrontmatterMode;
  className?: string;
  resolvedTheme?: ResolvedTheme;
  showCodeCopyActions?: boolean;
  highlightTerm?: string | null;
  disableApplicationLinks?: boolean;
  disableLocalResources?: boolean;
  isStreaming?: boolean;
  onOpenWikiLink?: (target: string) => void;
  onOpenRelativeMarkdownLink?: (target: MarkdownRelativeLinkTarget) => void;
}

/**
 * Renders the application's sanitized Markdown HTML, then replaces only fenced
 * `mermaid` code blocks with local SVG diagrams. Keeping this behind one
 * component makes note previews and AI answers follow the same safety rules.
 */
const MarkdownContent = forwardRef<HTMLDivElement, MarkdownContentProps>(function MarkdownContent(
  {
    content,
    frontmatter = 'preserve',
    currentPath,
    libraryPath,
    className,
    resolvedTheme,
    showCodeCopyActions = false,
    highlightTerm,
    disableApplicationLinks = false,
    disableLocalResources = false,
    externalAssetUrls,
    isStreaming = false,
    onOpenWikiLink,
    onOpenRelativeMarkdownLink,
  },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewedImage, setViewedImage] = useState<MarkdownImageViewerImage | null>(null);
  const onOpenWikiLinkRef = useRef(onOpenWikiLink);
  const onOpenRelativeMarkdownLinkRef = useRef(onOpenRelativeMarkdownLink);
  onOpenWikiLinkRef.current = onOpenWikiLink;
  onOpenRelativeMarkdownLinkRef.current = onOpenRelativeMarkdownLink;
  const html = useMemo(
    () => {
      const rendered = renderPreviewHtml(content, disableLocalResources ? { frontmatter, externalAssetUrls } : { currentPath, libraryPath, frontmatter });
      if (!disableLocalResources) return rendered;
      // 本地 URL 在进入 DOM 前移除，防止借用当前笔记库的图片协议。
      const template = document.createElement('template'); template.innerHTML = rendered;
      template.content.querySelectorAll<HTMLElement>('*').forEach(element => {
        element.removeAttribute('srcset');
        for (const attribute of ['src', 'poster', 'data', 'background', 'href', 'xlink:href']) {
          const value = element.getAttribute(attribute);
          if (value && !(attribute === 'src' && Object.values(externalAssetUrls ?? {}).includes(value)) && !/^(?:https?:\/\/|#|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(value)) {
            if (element.tagName === 'A' && attribute === 'href' && externalAssetUrls) { element.dataset.externalDocumentHref = value; }
            element.removeAttribute(attribute);
          }
        }
        for (const attribute of ['style', 'fill', 'filter', 'clip-path', 'stroke']) {
          if (/(?:url\s*\(|@import)/i.test(element.getAttribute(attribute) ?? '')) element.removeAttribute(attribute);
        }
      });
      template.content.querySelectorAll<HTMLImageElement>('img').forEach(img => {
        if (!Object.values(externalAssetUrls ?? {}).includes(img.getAttribute('src') ?? '') && !/^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(img.getAttribute('src') ?? '')) {
          const placeholder = document.createElement('span'); placeholder.className = 'external-resource-placeholder';
          placeholder.textContent = img.alt || '[本地图片]'; img.replaceWith(placeholder);
        }
      });
      template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
        if (!/^(?:https?:\/\/|mailto:|tel:|#)/i.test(anchor.getAttribute('href') ?? '')) { anchor.removeAttribute('href'); anchor.setAttribute('aria-disabled', 'true'); }
      });
      return template.innerHTML;
    },
    [content, currentPath, frontmatter, libraryPath, disableLocalResources, externalAssetUrls],
  );
  const activeTheme = resolvedTheme ?? (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const renderVersion = `${activeTheme}:${html}`;
  const canOpenWikiLinks = !disableApplicationLinks && Boolean(onOpenWikiLink);
  const canOpenRelativeLinks = !disableApplicationLinks && Boolean(onOpenRelativeMarkdownLink);

  useImperativeHandle(forwardedRef, () => containerRef.current as HTMLDivElement);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleLinkClick = (event: MouseEvent) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Element)) return;

      const image = eventTarget.closest<HTMLImageElement>('img[src]');
      if (image && container.contains(image)) {
        const source = image.currentSrc || image.getAttribute('src')?.trim() || '';
        if (source) {
          event.preventDefault();
          setViewedImage({ src: source, alt: image.getAttribute('alt') ?? '' });
        }
        return;
      }

      const anchor = eventTarget.closest<HTMLAnchorElement>('a[href], a[data-wiki-link], a[data-external-document-href]');
      if (!anchor || !container.contains(anchor)) return;
      if (anchor.dataset.externalDocumentHref) { event.preventDefault(); onOpenRelativeMarkdownLinkRef.current?.({ href: anchor.dataset.externalDocumentHref, path: anchor.dataset.externalDocumentHref, fragment: '' } as MarkdownRelativeLinkTarget); return; }

      const wikiTarget = anchor.dataset.wikiLink?.trim();
      if (wikiTarget) {
        event.preventDefault();
        if (canOpenWikiLinks) onOpenWikiLinkRef.current?.(wikiTarget);
        return;
      }

      const href = anchor.getAttribute('href')?.trim() ?? '';
      const fragment = decodeHeadingFragment(href);
      if (fragment) {
        if (scrollToHeadingAnchor(container, fragment)) event.preventDefault();
        return;
      }
      if (href.startsWith('#')) return;

      const relativeTarget = parseRelativeMarkdownLinkHref(href);
      if (relativeTarget) {
        event.preventDefault();
        if (canOpenRelativeLinks) onOpenRelativeMarkdownLinkRef.current?.(relativeTarget);
        return;
      }

      // Standard web and system links continue through Electron's guarded
      // will-navigate/window-open policy. Everything else stays in the preview.
      if (isAllowedExternalHref(href)) return;
      if (href) event.preventDefault();
    };
    container.addEventListener('click', handleLinkClick);

    return () => container.removeEventListener('click', handleLinkClick);
  }, [canOpenRelativeLinks, canOpenWikiLinks]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || isStreaming) return;
    updateApplicationLinkAvailability(container, {
      canOpenWikiLinks,
      canOpenRelativeLinks,
    });
  }, [canOpenRelativeLinks, canOpenWikiLinks, html, isStreaming]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || isStreaming) return;

    const enhancementController = new AbortController();
    void enhanceMarkdownContainer(container, {
      resolvedTheme: activeTheme,
      showCodeCopyActions,
      renderMermaid: !disableLocalResources,
      interactive: true,
      signal: enhancementController.signal,
    });

    return () => {
      enhancementController.abort();
    };
  }, [
    activeTheme,
    html,
    isStreaming,
    showCodeCopyActions,
    disableLocalResources,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return highlightMarkdownText(container, highlightTerm);
  }, [highlightTerm, renderVersion]);

  useEffect(() => setViewedImage(null), [renderVersion]);

  const contentClassName = ['markdown-rendered-content', className, isStreaming ? 'is-streaming' : null].filter(Boolean).join(' ');
  return <>
    <div ref={containerRef} className={contentClassName} dangerouslySetInnerHTML={{ __html: html }} />
    {viewedImage ? <MarkdownImageViewer image={viewedImage} onClose={() => setViewedImage(null)} /> : null}
  </>;
});

const wikiLinkUnavailableMessage = '此预览暂不支持打开 Wiki 笔记';
const relativeLinkUnavailableMessage = '此预览暂不支持打开相对笔记链接';

function updateApplicationLinkAvailability(
  container: HTMLElement,
  capabilities: { canOpenWikiLinks: boolean; canOpenRelativeLinks: boolean },
): void {
  container.querySelectorAll<HTMLAnchorElement>('a[data-wiki-link]').forEach((anchor) => {
    setLinkAvailability(anchor, capabilities.canOpenWikiLinks, wikiLinkUnavailableMessage);
  });
  container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (!parseRelativeMarkdownLinkHref(anchor.getAttribute('href') ?? '')) return;
    setLinkAvailability(anchor, capabilities.canOpenRelativeLinks, relativeLinkUnavailableMessage);
  });
}

function setLinkAvailability(anchor: HTMLAnchorElement, enabled: boolean, message: string): void {
  if (enabled) {
    anchor.removeAttribute('aria-disabled');
    anchor.removeAttribute('data-navigation-disabled');
    if (anchor.title === message) anchor.removeAttribute('title');
    return;
  }

  anchor.setAttribute('aria-disabled', 'true');
  anchor.dataset.navigationDisabled = 'true';
  anchor.title = message;
}

function isAllowedExternalHref(href: string): boolean {
  return /^(?:https?:|mailto:|tel:)/i.test(href);
}

interface MarkdownTextMatch {
  node: Text;
  ranges: Array<{ start: number; end: number }>;
}

function highlightMarkdownText(container: HTMLElement, rawTerm: string | null | undefined): (() => void) | undefined {
  const term = rawTerm?.trim() ?? '';
  const highlightRegistry = (globalThis as unknown as {
    CSS?: { highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void } };
  }).CSS?.highlights;
  const highlightName = 'menghan-preview-search';
  if (!term) {
    highlightRegistry?.delete(highlightName);
    return undefined;
  }

  const matches = collectMarkdownTextMatches(container, term);
  if (matches.length === 0) {
    highlightRegistry?.delete(highlightName);
    return undefined;
  }

  const HighlightConstructor = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;
  if (highlightRegistry && HighlightConstructor) {
    const ranges = matches.flatMap((match) => match.ranges.map(({ start, end }) => {
      const range = match.node.ownerDocument.createRange();
      range.setStart(match.node, start);
      range.setEnd(match.node, end);
      return range;
    }));
    highlightRegistry.set(highlightName, new HighlightConstructor(...ranges));
    return () => highlightRegistry.delete(highlightName);
  }

  const wrappers: HTMLElement[] = [];
  matches.forEach((match) => {
    const fragment = match.node.ownerDocument.createDocumentFragment();
    let cursor = 0;
    match.ranges.forEach(({ start, end }) => {
      fragment.append(match.node.data.slice(cursor, start));
      const wrapper = match.node.ownerDocument.createElement('mark');
      wrapper.className = 'markdown-search-match';
      wrapper.textContent = match.node.data.slice(start, end);
      wrappers.push(wrapper);
      fragment.append(wrapper);
      cursor = end;
    });
    fragment.append(match.node.data.slice(cursor));
    match.node.replaceWith(fragment);
  });

  return () => {
    const parents = new Set<ParentNode>();
    wrappers.forEach((wrapper) => {
      if (!wrapper.parentNode) return;
      parents.add(wrapper.parentNode);
      wrapper.replaceWith(wrapper.textContent ?? '');
    });
    parents.forEach((parent) => parent.normalize());
  };
}

function collectMarkdownTextMatches(container: HTMLElement, term: string): MarkdownTextMatch[] {
  const normalizedTerm = normalizeMarkdownSearchText(term);
  if (!normalizedTerm || /\s/.test(normalizedTerm)) return collectLiteralTextMatches(container, term);
  return collectLiteralTextMatches(container, normalizedTerm);
}

function collectLiteralTextMatches(container: HTMLElement, term: string): MarkdownTextMatch[] {
  const normalizedTerm = term.toLocaleLowerCase('zh-Hans-CN');
  if (!normalizedTerm) return [];

  const matches: MarkdownTextMatch[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, 4);
  let currentNode = walker.nextNode();
  while (currentNode) {
    const node = currentNode as Text;
    const parent = node.parentElement;
    if (parent && !parent.closest(
      'script, style, textarea, .markdown-code-copy-button, .markdown-code-language-label, .markdown-heading-anchor',
    )) {
      const source = node.data.toLocaleLowerCase('zh-Hans-CN');
      const ranges: Array<{ start: number; end: number }> = [];
      let cursor = 0;
      while (cursor <= source.length - normalizedTerm.length) {
        const start = source.indexOf(normalizedTerm, cursor);
        if (start === -1) break;
        ranges.push({ start, end: start + normalizedTerm.length });
        cursor = start + Math.max(normalizedTerm.length, 1);
      }
      if (ranges.length > 0) matches.push({ node, ranges });
    }
    currentNode = walker.nextNode();
  }
  return matches;
}

export default MarkdownContent;
