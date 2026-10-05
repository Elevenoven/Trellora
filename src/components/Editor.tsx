import { defaultEditorPreferences, type EditorPreferences, editorContentWidths } from '../../shared/editorPreferences';
import { withRuntimeInputRules, RuntimeEditorPreferences } from '../editor/runtimeInputRules';
import { RichTextEscapeBoundary } from '../editor/escapeBoundary';
import { getNoteViewportRect } from '../editor/editorCoordinates';
import { pasteLiteralText, pasteClipboardText, clipboardPlainText } from '../editor/pastePolicy';
import { useTypewriterScroll } from '../hooks/useTypewriterScroll';
import { t, useI18n } from '../i18n';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import { common, createLowlight } from 'lowlight';
import MenuBar from './MenuBar';
import EditorLinkDialog, { type EditorLinkRequest } from './EditorLinkDialog';
import type { HeadingEntry, SavedEditorImage } from '../electron';
import {
    contentToEditorHtml,
    getMarkdownLineAnchors,
    htmlToMarkdown,
    normalizeOrderedListStarts,
    stripSearchMarks,
    type MarkdownLineAnchorKind,
} from '../utils/markdown';
import { extractRenderedHeadings } from '../utils/outline';
import { replaceContentWithoutHistory } from '../editor/contentSync';
import { FineGrainedHistory } from '../editor/fineGrainedHistory';
import {
    CodeBlockSelectAll,
    MarkdownCodeBlockLowlight,
    normalizePastedCodeBlockLanguages,
} from '../editor/markdownCodeBlock';
import { TableDoubleEnterExit } from '../editor/tableDoubleEnterExit';
import { BlockBoundary } from '../editor/blockBoundary';
import { FormulaBlock, InlineFormula } from '../editor/formulaBlock';
import 'katex/dist/katex.min.css';
import SelectionActionOverlay from './SelectionActionOverlay';
import type { SelectionSnapshot } from '../editor/selectionActions';
import type { SelectionExpansionApplyRequest } from '../editor/selectionExpansion';
import {
    CODE_LANGUAGE_ICON_MARKS,
    CODE_LANGUAGE_OPTIONS,
    normalizeCodeLanguage,
    toCodeBlockLanguage,
} from '../utils/codeLanguages';
import {
    getClipboardImageSources,
    getDroppedImageSources,
    toEditorImageUrl,
    type ClipboardImageSource,
} from '../utils/editorImageClipboard';

interface EditorProps {
    content: string;
    preferences?: EditorPreferences;
    active?: boolean;
    currentPath: string;
    libraryPath?: string | null;
    zoom?: number;
    isInteractionBlocked: boolean;
    readOnly?: boolean;
    allowDocumentAi?: boolean;
    showLineNumbers?: boolean;
    highlightTerm?: string | null;
    headingJump?: { heading: HeadingEntry; nonce: number } | null;
    scrollTarget?: { text?: string; lineFrom?: number; lineTo?: number; nonce: number } | null;
    onChange: (content: string) => void;
    onOutlineChange: (headings: HeadingEntry[]) => void;
    onOpenWikiLink: (target: string) => void;
    onSaveImage: (source: ClipboardImageSource) => Promise<SavedEditorImage>;
    onOpenSelectionExpansion?: (snapshot: SelectionSnapshot) => void;
    onPrepareSelectionEditSource?: (snapshot: SelectionSnapshot) => Promise<{ contentHash: string }>;
    selectionExpansionApply?: SelectionExpansionApplyRequest | null;
    onSelectionExpansionApplyResult?: (result: { id: string; applied: boolean; message?: string }) => void;
}

const lowlight = createLowlight(common);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface CodeLanguagePopoverState {
    pre: HTMLElement;
    language: string;
    query: string;
    filterQuery: string;
    activeOptionValue: string | null;
    top: number;
    left: number;
}

interface EditorLineMarker {
    line: number;
    top: number;
}

interface EditorLineTarget {
    line: number;
    element: HTMLElement;
}

const WikiLink = Link.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            wikiLink: {
                default: null,
                parseHTML: element => element.getAttribute('data-wiki-link'),
                renderHTML: attributes => (
                    attributes.wikiLink ? { 'data-wiki-link': attributes.wikiLink } : {}
                ),
            },
            wikiAlias: {
                default: null,
                parseHTML: element => element.getAttribute('data-wiki-alias'),
                renderHTML: attributes => (
                    attributes.wikiAlias ? { 'data-wiki-alias': attributes.wikiAlias } : {}
                ),
            },
        };
    },
});
const AttachmentImage = Image.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            relativeSrc: {
                default: null,
                parseHTML: element => element.getAttribute('data-menghan-relative'),
                renderHTML: attributes => (
                    attributes.relativeSrc ? { 'data-menghan-relative': attributes.relativeSrc } : {}
                ),
            },
        };
    },
});
const PreservedBlankLine = Extension.create({
    name: 'menghanPreservedBlankLine',
    addGlobalAttributes() {
        return [{
            types: ['paragraph'],
            attributes: {
                menghanBlankLine: {
                    default: null,
                    parseHTML: element => element.getAttribute('data-menghan-blank-line'),
                    renderHTML: attributes => (
                        attributes.menghanBlankLine ? { 'data-menghan-blank-line': 'true' } : {}
                    ),
                },
            },
        }];
    },
});

const Editor: React.FC<EditorProps> = ({ content, preferences = defaultEditorPreferences, active = true, currentPath, libraryPath, zoom = 1, isInteractionBlocked, readOnly = false, allowDocumentAi = true, showLineNumbers = false, highlightTerm, headingJump, scrollTarget, onChange, onOutlineChange, onOpenWikiLink, onSaveImage, onOpenSelectionExpansion, onPrepareSelectionEditSource, selectionExpansionApply, onSelectionExpansionApplyResult }) => {
    const { language } = useI18n();
    const lastEmittedMarkdownRef = useRef<string | null>(null);
    const sourceMarkdownRef = useRef(content);
    const editorContainerRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const preferenceRef = useRef(preferences);
    useLayoutEffect(() => { preferenceRef.current = preferences; }, [preferences]);
    const notePathRef = useRef(currentPath);
    useLayoutEffect(() => { notePathRef.current = currentPath; }, [currentPath]);
    const [viewportWidth, setViewportWidth] = useState(900);
    const onSaveImageRef = useRef(onSaveImage);
    const [codeLanguagePopover, setCodeLanguagePopover] = useState<CodeLanguagePopoverState | null>(null);
    const [linkRequest, setLinkRequest] = useState<EditorLinkRequest | null>(null);
    const [lineMarkers, setLineMarkers] = useState<EditorLineMarker[]>([]);
    const editorHtml = useMemo(() => contentToEditorHtml(content, { currentPath, libraryPath }), [content, currentPath, libraryPath]);
    const codeLanguageQuery = codeLanguagePopover?.filterQuery;
    const visibleCodeLanguageOptions = useMemo(() => {
        if (codeLanguageQuery === undefined) return [];
        const query = codeLanguageQuery.trim();
        const normalizedQuery = normalizeCodeLanguage(query);
        return CODE_LANGUAGE_OPTIONS
            .filter(option => !query
                || option.value.includes(normalizedQuery)
                || option.label.toLocaleLowerCase('zh-Hans-CN').includes(query.toLocaleLowerCase('zh-Hans-CN')));
    }, [codeLanguageQuery]);
    const activeCodeLanguageOption = visibleCodeLanguageOptions.find(option => (
        option.value === (codeLanguagePopover?.activeOptionValue
            ?? normalizeCodeLanguage(codeLanguagePopover?.query))
    )) ?? null;
    const emitOutline = useCallback((root: ParentNode) => {
        onOutlineChange(extractRenderedHeadings(root));
    }, [onOutlineChange]);

    const editor = useEditor({
        editable: !readOnly,
        extensions: [
            RuntimeEditorPreferences,
            RichTextEscapeBoundary,
            StarterKit.extend({ addExtensions() { return (this.parent?.() ?? []).map(extension => withRuntimeInputRules(extension)); } }).configure({
                codeBlock: false,
                history: {
                    newGroupDelay: 0,
                },
            }),
            PreservedBlankLine,
            FineGrainedHistory,
            withRuntimeInputRules(MarkdownCodeBlockLowlight).configure({
                lowlight,
            }),
            FormulaBlock,
            InlineFormula,
            CodeBlockSelectAll,
            Table.configure({
                resizable: false,
            }),
            TableRow,
            TableHeader,
            TableCell,
            TableDoubleEnterExit,
            BlockBoundary,
            TaskList,
            withRuntimeInputRules(TaskItem).configure({
                nested: true,
            }),
            Highlight.configure({ multicolor: true }),
            WikiLink.configure({
                autolink: false,
                linkOnPaste: false,
                openOnClick: false,
            }),
            AttachmentImage.configure({
                inline: false,
                allowBase64: false,
            }),
            Placeholder.configure({
                placeholder: () => t('输入内容…'),
            }),
        ],
        content: editorHtml,
        onUpdate: ({ editor }) => {
            const cleanHtml = stripSearchMarks(editor.getHTML());
            const markdown = htmlToMarkdown(cleanHtml, sourceMarkdownRef.current);
            sourceMarkdownRef.current = markdown;
            lastEmittedMarkdownRef.current = markdown;
            onChange(markdown);
            emitOutline(editor.view.dom);
        },
        editorProps: {
            attributes: {
                class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none',
                style: 'padding: 20px 0;',
            },
            transformPastedHTML: html => normalizePastedCodeBlockLanguages(
                normalizeOrderedListStarts(html),
                lowlight,
            ),
            handleScrollToSelection: view => {
                const viewport = viewportRef.current;
                if (!viewport) return false;
                // ProseMirror's default also scrolls clipped ancestors and can move the toolbars.
                const selection = view.state.selection;
                const ensureVisible = () => {
                    if (view.isDestroyed || !view.state.selection.eq(selection) || viewportRef.current !== viewport || !viewport.getClientRects().length) return;
                    const caret = getNoteViewportRect(view.coordsAtPos(selection.head), view.dom);
                    const rect = viewport.getBoundingClientRect();
                    if (caret.top < rect.top + 16) viewport.scrollTop -= rect.top + 16 - caret.top;
                    else if (caret.bottom > rect.bottom - 16) viewport.scrollTop += caret.bottom - rect.bottom + 16;
                };
                ensureVisible();
                // React NodeViews/toolbar wrapping can finish layout after the transaction callback.
                requestAnimationFrame(ensureVisible);
                return true;
            },
            handleKeyDown: (view, event) => {
                if (event.isComposing || !view.editable || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'v') return false;
                event.preventDefault();
                const doc = view.state.doc, selection = view.state.selection;
                const notePath = notePathRef.current;
                void window.electronAPI.readClipboardText().then(text => {
                    if (editor && notePathRef.current === notePath && !view.isDestroyed && view.editable && view.state.doc === doc && view.state.selection.eq(selection)) pasteLiteralText(editor, text);
                }).catch(error => window.alert(String(error)));
                return true;
            },
            handlePaste: (view, event) => {
                if (!event.clipboardData) return false;
                if (!view.editable) return true;
                const text = event.clipboardData.getData('text/plain');
                const html = event.clipboardData.getData('text/html');
                const sources = getClipboardImageSources(event.clipboardData);
                if (preferenceRef.current.editorPasteMode === 'plain-text' && (text || clipboardPlainText({ text, html }).trim() || sources.length === 0)) {
                    event.preventDefault();
                    if (editor) pasteClipboardText(editor, { text, html }, 'plain-text');
                    return true;
                }
                if (sources.length === 0) {
                    event.preventDefault();
                    if (editor) pasteClipboardText(editor, { text, html }, preferenceRef.current.editorPasteMode);
                    return true;
                }

                event.preventDefault();
                const originalDoc = view.state.doc, originalSelection = view.state.selection;
                const notePath = notePathRef.current;
                void (async () => {
                    const savedImages = [];
                    for (const source of sources) savedImages.push(await onSaveImageRef.current(source));
                    if (notePathRef.current !== notePath || view.isDestroyed || !view.editable || view.state.doc !== originalDoc || !view.state.selection.eq(originalSelection)) return;
                    for (const saved of savedImages) {
                        const imageNode = view.state.schema.nodes.image?.create({
                            src: toEditorImageUrl(saved.absolutePath),
                            alt: saved.fileName,
                            relativeSrc: saved.markdownPath,
                        });
                        if (!imageNode) throw new Error('编辑器图片节点不可用。');
                        view.dispatch(view.state.tr.replaceSelectionWith(imageNode).scrollIntoView());
                        view.focus();
                    }
                })().catch((error) => {
                    window.alert(t("图片粘贴失败：{0}", { '0': error instanceof Error ? error.message : String(error) }));
                });
                return true;
            },
        },
    });

    useLayoutEffect(() => { if (editor) Object.assign(editor.storage.editorPreferences, preferences); }, [editor, preferences]);

    const layoutKey = `${preferences.editorFontSizePx}:${preferences.editorLineHeight}:${preferences.editorParagraphSpacingPx}:${preferences.editorContentWidth}:${zoom}:${showLineNumbers}`;
    const typewriterTarget = useCallback(() => {
        const scroller = viewportRef.current, content = editorContainerRef.current;
        if (!editor || editor.isDestroyed || !scroller || !content || !editor.isEditable) return null;
        const parent = editor.state.selection.$head.parent;
        return { scroller, content, collapsed: editor.state.selection.empty,
            caret: parent.type.spec.code || ['formulaBlock', 'inlineFormula'].includes(parent.type.name) ? null : getNoteViewportRect(editor.view.coordsAtPos(editor.state.selection.head), editor.view.dom) };
    }, [editor]);
    useTypewriterScroll({ enabled: preferences.editorTypewriterModeEnabled, active: active && !isInteractionBlocked && !readOnly,
        getTarget: typewriterTarget, layoutKey, navigationKey: `${headingJump?.nonce}:${scrollTarget?.nonce}`, zoom });
    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const observer = new ResizeObserver(() => setViewportWidth(viewport.clientWidth));
        observer.observe(viewport); setViewportWidth(viewport.clientWidth);
        return () => observer.disconnect();
    }, []);

    // 只刷新占位符装饰；不修改正文、选区或撤销历史，也不重新创建编辑器。
    useEffect(() => {
        if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('interfaceLanguage', language).setMeta('addToHistory', false));
    }, [editor, language]);

    useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);

    useEffect(() => { setLinkRequest(null); }, [currentPath, readOnly, isInteractionBlocked]);

    useEffect(() => {
        onSaveImageRef.current = onSaveImage;
    }, [onSaveImage]);

    // Update content if changed externally (e.g. switching files)
    useEffect(() => {
        sourceMarkdownRef.current = content;
        if (editor) {
            if (content !== lastEmittedMarkdownRef.current) {
                replaceContentWithoutHistory(editor, editorHtml);
            }
            requestAnimationFrame(() => emitOutline(editor.view.dom));
        }
    }, [content, editor, editorHtml, emitOutline]);

    useEffect(() => {
        if (!editor || !showLineNumbers) {
            setLineMarkers([]);
            return;
        }

        let animationFrame = 0;
        const refreshLineMarkers = () => {
            window.cancelAnimationFrame(animationFrame);
            animationFrame = window.requestAnimationFrame(() => {
                const container = editorContainerRef.current;
                if (!container || editor.isDestroyed) return;
                const nextMarkers = measureEditorLineMarkers(content, editor.view.dom, container);
                setLineMarkers((previous) => lineMarkersEqual(previous, nextMarkers) ? previous : nextMarkers);
            });
        };

        refreshLineMarkers();
        editor.on('transaction', refreshLineMarkers);
        window.addEventListener('resize', refreshLineMarkers);
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(refreshLineMarkers);
        resizeObserver?.observe(editor.view.dom);

        return () => {
            window.cancelAnimationFrame(animationFrame);
            editor.off('transaction', refreshLineMarkers);
            window.removeEventListener('resize', refreshLineMarkers);
            resizeObserver?.disconnect();
        };
    }, [content, editor, showLineNumbers, layoutKey, viewportWidth]);

    // Handle search term highlighting
    useEffect(() => {
        if (!editor) return;

        if (highlightTerm && highlightTerm.length > 0) {
            // Give the editor a moment to render content
            setTimeout(() => {
                editor.commands.unsetHighlight();

                const { doc } = editor.state;
                const positions: { from: number; to: number }[] = [];

                doc.descendants((node, pos) => {
                    if (node.isText && node.text) {
                        try {
                            const regex = new RegExp(escapeRegExp(highlightTerm), 'gi');
                            let match;
                            while ((match = regex.exec(node.text)) !== null) {
                                positions.push({
                                    from: pos + match.index,
                                    to: pos + match.index + highlightTerm.length,
                                });
                            }
                        } catch (e) {
                            // Ignore invalid regex characters
                        }
                    }
                });

                // Apply highlights in a single transaction
                if (positions.length > 0) {
                    let chain = editor.chain();
                    positions.forEach(p => {
                        chain = chain.setTextSelection(p).setHighlight();
                    });
                    // Reset selection to start after highlighting
                    chain.setTextSelection(0).run();
                }
            }, 100);
        } else {
            editor.commands.unsetHighlight();
        }
    }, [highlightTerm, editor, content]);

    useEffect(() => {
        if (!editor || !headingJump) return;
        const timer = setTimeout(() => {
            const headings = editor.view.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
            const target = [...headings][headingJump.heading.index]
                ?? [...headings].find((heading) => heading.innerText.trim() === headingJump.heading.text);
            flashAndScroll(target);
        }, 120);
        return () => clearTimeout(timer);
    }, [editor, headingJump, content]);

    useEffect(() => {
        const lineFrom = scrollTarget?.lineFrom;
        const hasLineTarget = typeof lineFrom === 'number' && Number.isInteger(lineFrom) && lineFrom > 0;
        const fallbackText = scrollTarget?.text?.trim() ?? '';
        if (!editor || (!hasLineTarget && !fallbackText)) return;
        const timer = setTimeout(() => {
            const lineTarget = hasLineTarget
                ? findEditorLineTarget(content, editor.view.dom, lineFrom)
                : undefined;
            if (lineTarget) {
                flashAndScroll(lineTarget);
                return;
            }

            const normalizedTarget = normalizeSearchText(fallbackText);
            if (!normalizedTarget) return;
            const anchor = normalizedTarget.slice(0, Math.min(72, normalizedTarget.length));
            const blocks = editor.view.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, [data-code-block], td');
            const target = [...blocks].find((block) => {
                const text = normalizeSearchText(block.innerText);
                if (!text) return false;
                return text.includes(anchor) || anchor.includes(text.slice(0, Math.min(48, text.length)));
            });
            flashAndScroll(target);
        }, 120);
        return () => clearTimeout(timer);
    }, [editor, scrollTarget, content]);

    const getSelectedCodeBlockLanguage = useCallback((): string | null => {
        if (!editor) return null;
        const { selection } = editor.state;
        if (selection instanceof NodeSelection && selection.node.type.name === 'codeBlock') {
            return typeof selection.node.attrs.language === 'string' ? selection.node.attrs.language : '';
        }

        for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
            const node = selection.$from.node(depth);
            if (node.type.name === 'codeBlock') {
                return typeof node.attrs.language === 'string' ? node.attrs.language : '';
            }
        }

        return null;
    }, [editor]);

    const getCodeBlockDomLanguage = (pre: HTMLElement): string => {
        const code = pre.querySelector('code');
        const explicitLanguage = pre.dataset.language ?? code?.dataset.language ?? '';
        if (explicitLanguage) return explicitLanguage;
        const className = `${pre.className} ${code?.className ?? ''}`;
        return className.match(/(?:^|\s)language-([\w-]+)/)?.[1] ?? '';
    };

    const getCodeLanguagePopoverPosition = useCallback((pre: HTMLElement) => {
        const container = editorContainerRef.current;
        if (!container) return null;

        const preRect = pre.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const scale = containerRect.width / container.offsetWidth || 1;
        return {
            top: (preRect.bottom - containerRect.top) / scale + container.scrollTop,
            left: (preRect.right - containerRect.left) / scale + container.scrollLeft,
        };
    }, []);

    const showCodeLanguagePopover = useCallback((pre: HTMLElement) => {
        requestAnimationFrame(() => {
            const position = getCodeLanguagePopoverPosition(pre);
            if (!position) return;
            // An empty Tiptap attribute is a valid "plain text" state, but it
            // must not hide a language class that was already present on the DOM.
            const language = normalizeCodeLanguage(getSelectedCodeBlockLanguage() || getCodeBlockDomLanguage(pre));
            setCodeLanguagePopover({
                pre,
                language,
                query: language,
                filterQuery: '',
                activeOptionValue: language,
                ...position,
            });
        });
    }, [getCodeLanguagePopoverPosition, getSelectedCodeBlockLanguage]);

    const applyCodeLanguage = useCallback((value: string) => {
        if (!editor) return;
        const language = normalizeCodeLanguage(value);
        editor.chain().focus().updateAttributes('codeBlock', { language: toCodeBlockLanguage(language) }).run();
        setCodeLanguagePopover(previous => previous ? {
            ...previous,
            language,
            query: language,
            filterQuery: '',
            activeOptionValue: language,
        } : previous);
    }, [editor]);

    const moveActiveCodeLanguageOption = useCallback((direction: -1 | 1) => {
        if (visibleCodeLanguageOptions.length === 0) return;
        setCodeLanguagePopover(previous => {
            if (!previous) return previous;
            const currentValue = previous.activeOptionValue
                ?? normalizeCodeLanguage(previous.query);
            const currentIndex = visibleCodeLanguageOptions.findIndex(option => option.value === currentValue);
            const nextIndex = currentIndex === -1
                ? (direction > 0 ? 0 : visibleCodeLanguageOptions.length - 1)
                : (currentIndex + direction + visibleCodeLanguageOptions.length) % visibleCodeLanguageOptions.length;
            return {
                ...previous,
                activeOptionValue: visibleCodeLanguageOptions[nextIndex]?.value ?? null,
            };
        });
    }, [visibleCodeLanguageOptions]);

    useEffect(() => {
        if (!editor) return;
        const handleSelectionUpdate = () => {
            const selectedLanguage = getSelectedCodeBlockLanguage();
            if (selectedLanguage === null) {
                setCodeLanguagePopover(null);
                return;
            }
            const language = normalizeCodeLanguage(selectedLanguage);
            setCodeLanguagePopover(previous => previous && previous.language !== language ? {
                ...previous,
                language,
                query: language,
                filterQuery: '',
                activeOptionValue: language,
            } : previous);
        };
        editor.on('transaction', handleSelectionUpdate);
        return () => {
            editor.off('transaction', handleSelectionUpdate);
        };
    }, [editor, getSelectedCodeBlockLanguage]);

    useEffect(() => {
        const pre = codeLanguagePopover?.pre;
        if (!pre) return;

        const refreshPosition = () => {
            const position = getCodeLanguagePopoverPosition(pre);
            if (!position) return;
            setCodeLanguagePopover(previous => previous ? { ...previous, ...position } : previous);
        };
        const container = viewportRef.current;
        window.addEventListener('resize', refreshPosition);
        container?.addEventListener('scroll', refreshPosition);
        return () => {
            window.removeEventListener('resize', refreshPosition);
            container?.removeEventListener('scroll', refreshPosition);
        };
    }, [codeLanguagePopover?.pre, getCodeLanguagePopoverPosition]);

    const handleEditorClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        if (target.closest('.code-language-popover')) return;

        const codeBlock = target.closest<HTMLElement>('[data-code-block], pre');
        if (codeBlock) {
            showCodeLanguagePopover(codeBlock);
        } else {
            setCodeLanguagePopover(null);
        }

        const wikiLink = target.closest<HTMLAnchorElement>('a[data-wiki-link]');
        if (!wikiLink) return;

        event.preventDefault();
        const linkTarget = wikiLink.dataset.wikiLink;
        if (linkTarget) onOpenWikiLink(linkTarget);
    };

    const insertImageSources = async (sources: ClipboardImageSource[]) => {
        if (!editor) return;
        for (const source of sources) {
            const saved = await onSaveImage(source);
            if (editor.isDestroyed) return;
            editor.chain().focus().setImage({
                src: toEditorImageUrl(saved.absolutePath),
                alt: saved.fileName,
                relativeSrc: saved.markdownPath,
            } as { src: string; alt?: string; title?: string }).run();
        }
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
        const sources = getDroppedImageSources(event.dataTransfer);
        if (sources.length === 0) return;
        event.preventDefault();
        void insertImageSources(sources).catch((error) => {
            window.alert(`图片导入失败：${error instanceof Error ? error.message : String(error)}`);
        });
    };

    // 两个链接入口都在弹窗夺取焦点前保存选区和文档，提交时检查原文仍然有效。
    const openLinkEditor = (range?: { from: number; to: number }) => {
        if (!editor || !editor.isEditable || isInteractionBlocked) return;
        setCodeLanguagePopover(null);
        const targetRange = range ?? { from: editor.state.selection.from, to: editor.state.selection.to };
        setLinkRequest({ range: targetRange, doc: editor.state.doc, currentPath });
    };

    return (
        <div
            className="editor-wrapper"
            style={{
                display: 'flex',
                flex: '1 1 0',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
                overflow: 'hidden',
            }}
        >
            <MenuBar editor={editor} onEditLink={() => openLinkEditor()} />
            <div className="editor-viewport" ref={viewportRef}>
            <div
                ref={editorContainerRef}
                className={`editor-container${showLineNumbers ? ' with-line-numbers' : ''}`}
                data-current-path={currentPath}
                onClick={handleEditorClick}
                onDrop={handleDrop}
                style={{
                    maxWidth: Math.min((editorContentWidths[preferences.editorContentWidth] || viewportWidth / zoom) + (showLineNumbers ? 40 : 0), viewportWidth / zoom),
                    margin: '0 auto',
                    minHeight: '100%',
                    width: '100%',
                    boxSizing: 'border-box',
                    zoom,
                }}
            >
                <EditorContent editor={editor} />
                {showLineNumbers && lineMarkers.length > 0 ? (
                    <div className="editor-line-number-layer" aria-hidden="true">
                        {lineMarkers.map((marker) => (
                            <span
                                key={marker.line}
                                className="editor-line-number"
                                style={{ top: marker.top }}
                            >
                                L{marker.line}
                            </span>
                        ))}
                    </div>
                ) : null}
                {codeLanguagePopover && (
                    <div
                        className="code-language-popover"
                        style={{ top: codeLanguagePopover.top, left: codeLanguagePopover.left }}
                        onMouseDown={event => event.stopPropagation()}
                    >
                        <div className="code-language-popover-title">{t("代码语言")}</div>
                        <input
                            aria-label={t("代码语言")}
                            aria-activedescendant={activeCodeLanguageOption ? `code-language-option-${activeCodeLanguageOption.value}` : undefined}
                            aria-controls="code-language-options"
                            aria-expanded="true"
                            className="code-language-input"
                            value={codeLanguagePopover.query}
                            placeholder={t("输入语言，如 python")}
                            onChange={event => setCodeLanguagePopover(previous => previous ? {
                                ...previous,
                                query: event.target.value,
                                filterQuery: event.target.value,
                                activeOptionValue: null,
                            } : previous)}
                            onKeyDown={event => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    moveActiveCodeLanguageOption(event.key === 'ArrowUp' ? -1 : 1);
                                    return;
                                }
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    applyCodeLanguage(activeCodeLanguageOption?.value ?? event.currentTarget.value);
                                }
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    setCodeLanguagePopover(null);
                                }
                            }}
                        />
                        <div id="code-language-options" className="code-language-options" role="listbox" aria-label={t("所有代码语言")}>
                            {visibleCodeLanguageOptions.map(option => (
                                    <button
                                        id={`code-language-option-${option.value}`}
                                        key={option.value}
                                        type="button"
                                        className={`code-language-option${option.value === activeCodeLanguageOption?.value ? ' active' : ''}`}
                                        role="option"
                                        aria-selected={option.value === activeCodeLanguageOption?.value}
                                        onMouseDown={event => {
                                            event.preventDefault();
                                            applyCodeLanguage(option.value);
                                        }}
                                    >
                                        <span
                                            className={`code-language-option-icon is-${option.value}`}
                                            aria-hidden="true"
                                        >
                                            {CODE_LANGUAGE_ICON_MARKS[option.value] ?? 'CODE'}
                                        </span>
                                        <span>{t(option.label)}</span>
                                        <span className="code-language-option-value">{option.value}</span>
                                    </button>
                                ))}
                        </div>
                        <div className="code-language-hint">{t("Enter 应用 · Esc 关闭")}</div>
                    </div>
                )}
            </div>
            </div>
            <SelectionActionOverlay allowDocumentAi={allowDocumentAi} preferences={preferences} toolbarBlocked={Boolean(linkRequest) || !active} onSaveImage={onSaveImage} editor={editor} currentPath={currentPath}
                isInteractionBlocked={isInteractionBlocked}
                onEditLink={openLinkEditor}
                onOpenSelectionExpansion={onOpenSelectionExpansion}
                onPrepareSelectionEditSource={onPrepareSelectionEditSource}
                selectionExpansionApply={selectionExpansionApply}
                onSelectionExpansionApplyResult={onSelectionExpansionApplyResult}
            />
            {editor && linkRequest && linkRequest.currentPath === currentPath && !readOnly && !isInteractionBlocked && (
                <EditorLinkDialog
                    editor={editor}
                    request={linkRequest}
                    onClose={() => setLinkRequest(null)}
                />
            )}
        </div>
    );
};

const lineAnchorSelectors: Record<MarkdownLineAnchorKind, string> = {
    heading: 'h1, h2, h3, h4, h5, h6',
    paragraph: 'p',
    blockquote: 'blockquote',
    listItem: 'li',
    code: 'pre:not(.mermaid-editor-source), .code-block-node-view',
    thematicBreak: 'hr',
    tableRow: 'tr',
};

function measureEditorLineMarkers(content: string, editorRoot: HTMLElement, container: HTMLElement): EditorLineMarker[] {
    const containerRect = container.getBoundingClientRect();
    const scale = containerRect.width / container.offsetWidth || 1;
    return mapEditorLineTargets(content, editorRoot).map((target) => ({
        line: target.line,
        top: Math.round((firstRenderedLineTop(target.element) - containerRect.top) / scale + container.scrollTop),
    }));
}

function findEditorLineTarget(content: string, editorRoot: HTMLElement, targetLine: number): HTMLElement | undefined {
    const targets = mapEditorLineTargets(content, editorRoot);
    let nearestBefore: EditorLineTarget | undefined;
    for (const target of targets) {
        if (target.line === targetLine) return target.element;
        if (target.line > targetLine) return nearestBefore?.element ?? target.element;
        nearestBefore = target;
    }
    return nearestBefore?.element;
}

function mapEditorLineTargets(content: string, editorRoot: HTMLElement): EditorLineTarget[] {
    const anchors = getMarkdownLineAnchors(content);
    const pools = new Map<MarkdownLineAnchorKind, { candidates: HTMLElement[]; cursor: number }>();
    const seenLines = new Set<number>();
    const targets: EditorLineTarget[] = [];

    for (const anchor of anchors) {
        let pool = pools.get(anchor.kind);
        if (!pool) {
            const candidates = [...editorRoot.querySelectorAll<HTMLElement>(lineAnchorSelectors[anchor.kind])]
                .filter((candidate) => anchor.kind !== 'paragraph' || !candidate.closest('td, th'));
            pool = { candidates, cursor: 0 };
            pools.set(anchor.kind, pool);
        }

        const candidateIndex = findLineAnchorCandidate(pool.candidates, pool.cursor, anchor.text);
        if (candidateIndex === -1) continue;
        const candidate = pool.candidates[candidateIndex];
        pool.cursor = candidateIndex + 1;
        if (seenLines.has(anchor.line)) continue;

        targets.push({
            line: anchor.line,
            element: candidate,
        });
        seenLines.add(anchor.line);
    }

    return targets;
}

function findLineAnchorCandidate(candidates: HTMLElement[], startIndex: number, anchorText: string): number {
    if (startIndex >= candidates.length) return -1;
    const normalizedAnchor = normalizeSearchText(anchorText);
    if (!normalizedAnchor) return startIndex;
    const anchorProbe = normalizedAnchor.slice(0, 96);

    for (let index = startIndex; index < candidates.length; index += 1) {
        const candidateText = normalizeSearchText(candidates[index].innerText);
        if (candidateText.includes(anchorProbe) || anchorProbe.includes(candidateText.slice(0, 72))) {
            return index;
        }
    }

    // Keep the gutter useful for nodes whose rendered text differs slightly
    // after Markdown normalization, while preserving source and DOM order.
    return startIndex;
}

function firstRenderedLineTop(element: HTMLElement): number {
    const document = element.ownerDocument;
    const textWalker = document.createTreeWalker(element, 4);
    let textNode = textWalker.nextNode();
    while (textNode) {
        const text = textNode.textContent ?? '';
        const firstTextOffset = text.search(/\S/);
        if (firstTextOffset !== -1) {
            const range = document.createRange();
            range.setStart(textNode, firstTextOffset);
            range.setEnd(textNode, firstTextOffset + 1);
            const rect = range.getBoundingClientRect();
            if (rect.height > 0) return rect.top;
        }
        textNode = textWalker.nextNode();
    }
    return element.getBoundingClientRect().top;
}

function lineMarkersEqual(left: EditorLineMarker[], right: EditorLineMarker[]): boolean {
    return left.length === right.length
        && left.every((marker, index) => marker.line === right[index].line && marker.top === right[index].top);
}

function normalizeSearchText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-Hans-CN');
}

function flashAndScroll(target: HTMLElement | undefined): void {
    if (!target) return;
    const highlightRegistry = (CSS as unknown as {
        highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };
    }).highlights;
    const HighlightConstructor = (globalThis as unknown as {
        Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    if (highlightRegistry && HighlightConstructor) {
        const range = new Range();
        range.selectNodeContents(target);
        highlightRegistry.delete('menghan-search-target');
        highlightRegistry.set('menghan-search-target', new HighlightConstructor(range));
        window.setTimeout(() => highlightRegistry.delete('menghan-search-target'), 2_400);
    } else {
        target.classList.add('search-target-flash');
        window.setTimeout(() => target.classList.remove('search-target-flash'), 2_400);
    }
    // Keep the visual location cue even if a platform-specific scroll API
    // rejects the options object. Some packaged Chromium configurations can
    // throw before scrolling, but highlighting the matched block must remain.
    try {
        const viewport = target.closest<HTMLElement>('.editor-viewport');
        if (viewport) {
            const targetRect = getNoteViewportRect(target.getBoundingClientRect(), target), viewportRect = viewport.getBoundingClientRect();
            viewport.scrollTo({ top: viewport.scrollTop + (targetRect.top + targetRect.bottom) / 2 - (viewportRect.top + viewportRect.bottom) / 2, behavior: 'smooth' });
        } else target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
        target.scrollIntoView();
    }
}

export default Editor;
