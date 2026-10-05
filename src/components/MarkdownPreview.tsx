import React, { useEffect, useRef } from 'react';
import 'katex/dist/katex.min.css';
import { scrollToHeadingAnchor } from '../utils/headingAnchors';
import { findMarkdownLineTarget, normalizeMarkdownSearchText } from '../utils/markdown';
import { extractRenderedHeadings } from '../utils/outline';
import type { MarkdownRelativeLinkTarget } from '../utils/markdownLinks';
import type { HeadingEntry } from '../electron';
import type { ResolvedTheme } from '../utils/theme';
import MarkdownContent from './MarkdownContent';
import type { MarkdownFrontmatterMode } from '../utils/markdownExtensions';

interface MarkdownPreviewProps {
    content: string;
    currentPath: string;
    libraryPath?: string | null;
    zoom?: number;
    frontmatter?: MarkdownFrontmatterMode;
    headingJump?: { heading: HeadingEntry; nonce: number } | null;
    highlightTerm?: string | null;
    scrollTarget?: { text?: string; lineFrom?: number; lineTo?: number; nonce: number } | null;
    resolvedTheme?: ResolvedTheme;
    showCodeCopyActions?: boolean;
    disableApplicationLinks?: boolean;
    disableLocalResources?: boolean;
    externalAssetUrls?: Record<string, string>;
    onOpenWikiLink?: (target: string) => void;
    onOpenRelativeMarkdownLink?: (target: MarkdownRelativeLinkTarget) => void;
    onOutlineChange: (headings: HeadingEntry[]) => void;
}

const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
    content,
    currentPath,
    libraryPath,
    zoom = 1,
    frontmatter = 'strip',
    headingJump,
    highlightTerm,
    scrollTarget,
    resolvedTheme,
    showCodeCopyActions,
    disableApplicationLinks,
    disableLocalResources,
    externalAssetUrls,
    onOpenWikiLink,
    onOpenRelativeMarkdownLink,
    onOutlineChange,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        onOutlineChange(extractRenderedHeadings(container));
    }, [content, currentPath, libraryPath, onOutlineChange]);

    useEffect(() => {
        if (!headingJump) return;
        const container = containerRef.current;
        if (!container) return;

        const headings = [...container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')];
        const indexedTarget = headingJump.heading.index >= 0
            ? headings[headingJump.heading.index]
            : undefined;
        const target = indexedTarget
            ?? headings.find((heading) => heading.id === headingJump.heading.id)
            ?? headings.find((heading) => heading.innerText.trim() === headingJump.heading.text);
        if (target) scrollToHeadingAnchor(container, target.id);
    }, [headingJump]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !scrollTarget) return;

        const lineFrom = scrollTarget.lineFrom;
        const hasLineTarget = typeof lineFrom === 'number' && Number.isInteger(lineFrom) && lineFrom > 0;
        const fallbackText = scrollTarget.text?.trim() ?? '';
        if (!hasLineTarget && !fallbackText) return;

        const lineTarget = hasLineTarget
            ? findMarkdownLineTarget(content, container, lineFrom)
            : undefined;
        const target = lineTarget ?? findPreviewTextTarget(container, fallbackText);
        return flashAndScrollPreviewTarget(target);
    }, [content, scrollTarget]);

    return (
        <div className="preview-container" style={{ zoom }}>
            <MarkdownContent
                ref={containerRef}
                className="preview-content"
                content={content}
                currentPath={currentPath}
                libraryPath={libraryPath}
                frontmatter={frontmatter}
                resolvedTheme={resolvedTheme}
                showCodeCopyActions={showCodeCopyActions}
                highlightTerm={highlightTerm}
                disableApplicationLinks={disableApplicationLinks}
                disableLocalResources={disableLocalResources}
                externalAssetUrls={externalAssetUrls}
                onOpenWikiLink={onOpenWikiLink}
                onOpenRelativeMarkdownLink={onOpenRelativeMarkdownLink}
            />
        </div>
    );
};

function findPreviewTextTarget(container: HTMLElement, value: string): HTMLElement | undefined {
    const normalizedTarget = normalizeMarkdownSearchText(value);
    if (!normalizedTarget) return undefined;
    const probe = normalizedTarget.slice(0, Math.min(72, normalizedTarget.length));
    const blocks = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td');
    return [...blocks].find((block) => {
        const text = normalizeMarkdownSearchText(block.innerText ?? block.textContent ?? '');
        if (!text) return false;
        return text.includes(probe) || probe.includes(text.slice(0, Math.min(48, text.length)));
    });
}

function flashAndScrollPreviewTarget(target: HTMLElement | undefined): (() => void) | undefined {
    if (!target) return undefined;

    const highlightName = 'menghan-search-target';
    const highlightRegistry = (globalThis as unknown as {
        CSS?: { highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void } };
    }).CSS?.highlights;
    const HighlightConstructor = (globalThis as unknown as {
        Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    let resetTimer: number | undefined;

    if (highlightRegistry && HighlightConstructor) {
        const range = target.ownerDocument.createRange();
        range.selectNodeContents(target);
        highlightRegistry.delete(highlightName);
        highlightRegistry.set(highlightName, new HighlightConstructor(range));
        resetTimer = window.setTimeout(() => highlightRegistry.delete(highlightName), 2_400);
    } else {
        target.classList.add('search-target-flash');
        resetTimer = window.setTimeout(() => target.classList.remove('search-target-flash'), 2_400);
    }

    try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
        target.scrollIntoView();
    }

    return () => {
        window.clearTimeout(resetTimer);
        highlightRegistry?.delete(highlightName);
        target.classList.remove('search-target-flash');
    };
}

export default MarkdownPreview;
