import { TextSelection } from '@tiptap/pm/state';
import { defaultEditorPreferences, type EditorPreferences } from '../../shared/editorPreferences';
import type { SavedEditorImage } from '../electron';
import { pasteClipboardText, clipboardPlainText } from '../editor/pastePolicy';
import { toEditorImageUrl, getClipboardImageSources, type ClipboardImageSource } from '../utils/editorImageClipboard';
import SelectionFloatingToolbar from './SelectionFloatingToolbar';
import { canHandleEditorEscape, consumeEditorEscape } from '../editor/escapeBoundary';
import { getNotePositionAtPoint } from '../editor/editorCoordinates';
import { getAppLanguage, t, useI18n } from '../i18n';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import {
    BookPlus,
    Bold,
    ChevronRight,
    ClipboardPaste,
    Code,
    Copy,
    FileCode2,
    Heading1,
    Heading2,
    Heading3,
    Heading4,
    Heading5,
    Heading6,
    Italic,
    Link,
    List,
    ListChecks,
    ListOrdered,
    Minus,
    Pilcrow,
    Quote,
    Scissors,
    Search,
    Sigma,
    Sparkles,
    Table2,
    X,
} from 'lucide-react';
import type { SelectionEditAction, SelectionEditRunResult } from '../electron';
import { primarySelectionEditQualityIssue, selectionEditQualityIssueLabel } from '../../electron/knowledge/selectionEditQuality';
import { countSelectionEditWords, MAX_SELECTION_EDIT_WORDS } from '../../shared/selectionEditLimits';
import type { SelectionExpansionApplyRequest } from '../editor/selectionExpansion';
import { createSelectionEditLauncherSession, type SelectionEditLauncherSession } from '../editor/selectionEdit';
import SelectionEditLauncher from './selection-edit/SelectionEditLauncher';
import SelectionEditSuggestion from './selection-edit/SelectionEditSuggestion';
import { copyPlainText } from '../utils/clipboard';
import {
    createSelectionExpansionSnapshot,
    createSelectionSnapshot,
    createSelectionLocatorCapture,
    getFloatingRect,
    getSameBlockContext,
    getSelectionWritebackCapability,
    isSelectionSnapshotCurrent,
    positionPopupBeside,
    positionPopupAtPointer,
    positionPopup,
    replaceSelectionWithText,
    replaceSelectionWithMarkdown,
    insertMarkdownBelowSelection,
    insertTextBelowBlock,
    type BlockTransform,
    type FloatingRect,
    type PointerAnchor,
    type SelectionSnapshot,
} from '../editor/selectionActions';

interface SelectionActionOverlayProps {
    editor: Editor | null;
    preferences?: EditorPreferences;
    toolbarBlocked?: boolean;
    onSaveImage?: (source: ClipboardImageSource) => Promise<SavedEditorImage>;
    allowDocumentAi?: boolean;
    currentPath: string;
    isInteractionBlocked: boolean;
    onEditLink: (range: { from: number; to: number }) => void;
    onOpenSelectionExpansion?: (snapshot: SelectionSnapshot) => void;
    onPrepareSelectionEditSource?: (snapshot: SelectionSnapshot) => Promise<{ contentHash: string }>;
    selectionExpansionApply?: SelectionExpansionApplyRequest | null;
    onSelectionExpansionApplyResult?: (result: { id: string; applied: boolean; message?: string }) => void;
}

interface Candidate {
    session: SelectionEditLauncherSession;
    result: SelectionEditRunResult;
    stale: boolean;
    applyError?: string;
}

interface SelectionContextMenuSession {
    snapshot: SelectionSnapshot | null;
    quickSnapshot: SelectionSnapshot | null;
    commandRange: { from: number; to: number };
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
    anchorPoint: PointerAnchor;
}

type SelectionSubmenuKind = 'paragraph' | 'insert';

interface SelectionSubmenuSession {
    kind: SelectionSubmenuKind;
    anchor: FloatingRect;
}

interface TablePickerSession {
    anchorPoint: PointerAnchor;
    rows: number;
    cols: number;
}

const quickActions: Array<{ action: SelectionEditAction; label: string; description: string }> = [
    { action: 'polish', label: '润色表达', description: '改善清晰度和连贯性' },
    { action: 'shorten', label: '精简', description: '保留重点，缩短篇幅' },
    { action: 'expand', label: '扩写', description: '补充必要解释' },
    { action: 'proofread', label: '校对', description: '修正语病与标点' },
    { action: 'explain', label: '解释', description: '用易懂文字说明' },
    { action: 'translate', label: '翻译', description: '翻译到指定语言' },
    { action: 'custom', label: '自定义', description: '按你的要求编辑' },
];

const tablePickerSize = 10;

const createRequestId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `selection-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

const toErrorMessage = (error: unknown): string => {
    if (error instanceof DOMException && error.name === 'AbortError') return '已取消生成。';
    if (error instanceof Error) return error.message || '未能生成建议，原文没有改动。';
    return '未能生成建议，原文没有改动。';
};

export default function SelectionActionOverlay({ editor, preferences = defaultEditorPreferences, toolbarBlocked = false, allowDocumentAi = true, onSaveImage, currentPath, isInteractionBlocked, onEditLink, onOpenSelectionExpansion, onPrepareSelectionEditSource, selectionExpansionApply, onSelectionExpansionApplyResult }: SelectionActionOverlayProps): JSX.Element | null {
  useI18n();
    const editorSessionIdRef = useRef(createRequestId());
    const notePathRef = useRef(currentPath);
    useLayoutEffect(() => { notePathRef.current = currentPath; }, [currentPath]);
    const docRevisionRef = useRef(0);
    const activeRequestIdRef = useRef<string | null>(null);
    const appliedExpansionRequestIdRef = useRef<string | null>(null);
    const selectionContextMenuRef = useRef<HTMLDivElement | null>(null);
    const selectionSubmenuRef = useRef<HTMLDivElement | null>(null);
    const tablePickerRef = useRef<HTMLDivElement | null>(null);
    const [selectionContextMenu, setSelectionContextMenu] = useState<SelectionContextMenuSession | null>(null);
    const [selectionContextMenuSize, setSelectionContextMenuSize] = useState({ width: 248, height: 548 });
    const [selectionContextFeedback, setSelectionContextFeedback] = useState<string | null>(null);
    const [selectionSubmenu, setSelectionSubmenu] = useState<SelectionSubmenuSession | null>(null);
    const [selectionSubmenuSize, setSelectionSubmenuSize] = useState({ width: 204, height: 238 });
    const [tablePicker, setTablePicker] = useState<TablePickerSession | null>(null);
    const [tablePickerSizeState, setTablePickerSizeState] = useState({ width: 276, height: 290 });
    const [floatingSnapshot, setFloatingSnapshot] = useState<SelectionSnapshot | null>(null);
    const [aiSession, setAiSession] = useState<SelectionEditLauncherSession | null>(null);
    const [aiSnapshotStale, setAiSnapshotStale] = useState(false);
    const [candidate, setCandidate] = useState<Candidate | null>(null);
    const [generating, setGenerating] = useState(false);
    const [allowStaleRegeneration, setAllowStaleRegeneration] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const closeSelectionContextMenu = useCallback(() => {
        setSelectionContextMenu(null);
        setSelectionContextFeedback(null);
        setSelectionSubmenu(null);
        setTablePicker(null);
    }, []);

    const cancelActiveRequest = useCallback(() => {
        const requestId = activeRequestIdRef.current;
        activeRequestIdRef.current = null;
        if (requestId) void window.electronAPI.cancelSelectionEdit(requestId);
        setGenerating(false);
    }, []);

    const dismissEditorInteractions = useCallback(() => {
        cancelActiveRequest();
        closeSelectionContextMenu();
        setAiSession(null);
        setAiSnapshotStale(false);
        setCandidate(null);
        setError(null);
        setAllowStaleRegeneration(false);
    }, [cancelActiveRequest, closeSelectionContextMenu]);

    const isCurrent = useCallback((snapshot: SelectionSnapshot): boolean => {
        if (!editor) return false;
        return isSelectionSnapshotCurrent({
            editor,
            snapshot,
            editorSessionId: editorSessionIdRef.current,
            currentPath,
            docRevision: docRevisionRef.current,
        });
    }, [currentPath, editor]);

    useEffect(() => {
        const request = selectionExpansionApply;
        if (!request || appliedExpansionRequestIdRef.current === request.id) return;
        appliedExpansionRequestIdRef.current = request.id;
        if (!editor || isInteractionBlocked || !isCurrent(request.snapshot)) {
            onSelectionExpansionApplyResult?.({ id: request.id, applied: false, message: '原文已变化，请重新选择文字后再生成。' });
            return;
        }
        try {
            replaceSelectionWithMarkdown(editor, request.snapshot, request.text);
            onSelectionExpansionApplyResult?.({ id: request.id, applied: true });
        } catch (applyError) {
            onSelectionExpansionApplyResult?.({
                id: request.id,
                applied: false,
                message: applyError instanceof Error ? applyError.message : '扩写建议无法写入编辑器。',
            });
        }
    }, [editor, isCurrent, isInteractionBlocked, onSelectionExpansionApplyResult, selectionExpansionApply]);

    const refreshFloatingPositions = useCallback(() => {
        if (!editor) return;
        setAiSession((previous) => previous ? {
            ...previous,
            snapshot: {
                ...previous.snapshot,
                rect: getFloatingRect(editor, previous.snapshot.from, previous.snapshot.to),
            },
        } : null);
        setCandidate((previous) => previous ? {
            ...previous,
            session: {
                ...previous.session,
                snapshot: {
                    ...previous.session.snapshot,
                    rect: getFloatingRect(editor, previous.session.snapshot.from, previous.session.snapshot.to),
                },
            },
        } : null);
    }, [editor]);

    useEffect(() => {
        if (!editor) return;
        const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
            if (transaction.docChanged) {
                docRevisionRef.current += 1;
                setCandidate((previous) => previous ? { ...previous, stale: true } : null);
                setAiSnapshotStale(true);
                closeSelectionContextMenu();
            }
        };
        const dismissForWindowExit = () => dismissEditorInteractions();
        const dismissForVisibilityChange = () => {
            if (document.visibilityState !== 'visible') dismissEditorInteractions();
        };
        const closeMenuForViewportChange = () => {
            refreshFloatingPositions();
            closeSelectionContextMenu();
        };
        const openSelectionContextMenu = (event: MouseEvent) => {
            if (isInteractionBlocked || event.defaultPrevented) return;
            const snapshot = createSelectionExpansionSnapshot({
                editor,
                editorSessionId: editorSessionIdRef.current,
                currentPath,
                docRevision: docRevisionRef.current,
            });
            const position = getNotePositionAtPoint(editor.view, { left: event.clientX, top: event.clientY });
            if (position === null) return;
            const openedInsideSelection = Boolean(
                snapshot
                && position >= snapshot.from
                && position <= snapshot.to,
            );
            event.preventDefault();
            const quickSnapshot = openedInsideSelection
                ? createSelectionSnapshot({
                    editor,
                    editorSessionId: editorSessionIdRef.current,
                    currentPath,
                    docRevision: docRevisionRef.current,
                })
                : null;
            const commandRange = quickSnapshot
                ? { from: quickSnapshot.from, to: quickSnapshot.to }
                : { from: position, to: position };
            if (!openedInsideSelection) {
                editor.chain().focus().setTextSelection(commandRange.from).run();
            }
            setSelectionContextFeedback(null);
            setSelectionSubmenu(null);
            setTablePicker(null);
            setSelectionContextMenu({
                snapshot: openedInsideSelection ? snapshot : null,
                quickSnapshot,
                commandRange,
                editorSessionId: editorSessionIdRef.current,
                currentPath,
                docRevision: docRevisionRef.current,
                anchorPoint: { x: event.clientX, y: event.clientY },
            });
        };
        const scrollContainer = editor.view.dom.closest<HTMLElement>('.editor-viewport');

        editor.on('transaction', onTransaction);
        editor.view.dom.addEventListener('contextmenu', openSelectionContextMenu, true);
        window.addEventListener('resize', closeMenuForViewportChange);
        window.addEventListener('blur', dismissForWindowExit);
        document.addEventListener('visibilitychange', dismissForVisibilityChange);
        scrollContainer?.addEventListener('scroll', closeMenuForViewportChange);

        return () => {
            editor.off('transaction', onTransaction);
            editor.view.dom.removeEventListener('contextmenu', openSelectionContextMenu, true);
            window.removeEventListener('resize', closeMenuForViewportChange);
            window.removeEventListener('blur', dismissForWindowExit);
            document.removeEventListener('visibilitychange', dismissForVisibilityChange);
            scrollContainer?.removeEventListener('scroll', closeMenuForViewportChange);
            cancelActiveRequest();
        };
    }, [cancelActiveRequest, closeSelectionContextMenu, currentPath, dismissEditorInteractions, editor, isInteractionBlocked, refreshFloatingPositions]);

    useEffect(() => {
        const onEscape = (event: KeyboardEvent) => {
            if (isInteractionBlocked || !canHandleEditorEscape(event) || event.key !== 'Escape') return;
            if (!selectionContextMenu && !aiSession && !candidate && !floatingSnapshot) return;
            consumeEditorEscape(event);
            setFloatingSnapshot(null);
            dismissEditorInteractions();
        };
        window.addEventListener('keydown', onEscape);
        return () => window.removeEventListener('keydown', onEscape);
    }, [isInteractionBlocked, selectionContextMenu, aiSession, candidate, floatingSnapshot, dismissEditorInteractions]);

    useEffect(() => {
        if (!isInteractionBlocked) return;
        dismissEditorInteractions();
        editor?.commands.blur();
    }, [dismissEditorInteractions, editor, isInteractionBlocked]);

    useEffect(() => {
        dismissEditorInteractions();
        docRevisionRef.current = 0;
    }, [currentPath, dismissEditorInteractions, editor]);

    useEffect(() => {
        if (!selectionContextMenu) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const eventPath = event.composedPath();
            if (selectionContextMenuRef.current && eventPath.includes(selectionContextMenuRef.current)) return;
            if (selectionSubmenuRef.current && eventPath.includes(selectionSubmenuRef.current)) return;
            closeSelectionContextMenu();
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer, true);
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    }, [closeSelectionContextMenu, selectionContextMenu]);

    useLayoutEffect(() => {
        if (!selectionContextMenu || !selectionContextMenuRef.current) return;
        const rect = selectionContextMenuRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            setSelectionContextMenuSize((previous) => previous.width === rect.width && previous.height === rect.height
                ? previous
                : { width: rect.width, height: rect.height });
        }
    }, [selectionContextFeedback, selectionContextMenu]);

    useLayoutEffect(() => {
        if (!selectionSubmenu || !selectionSubmenuRef.current) return;
        const rect = selectionSubmenuRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            setSelectionSubmenuSize((previous) => previous.width === rect.width && previous.height === rect.height
                ? previous
                : { width: rect.width, height: rect.height });
        }
    }, [selectionSubmenu]);

    useLayoutEffect(() => {
        if (!tablePicker || !tablePickerRef.current) return;
        const rect = tablePickerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            setTablePickerSizeState((previous) => previous.width === rect.width && previous.height === rect.height
                ? previous
                : { width: rect.width, height: rect.height });
        }
    }, [tablePicker]);

    const preventFocusLoss = (event: React.MouseEvent<HTMLElement>) => event.preventDefault();
    const selectionContextMenuPosition = selectionContextMenu
        ? positionPopupAtPointer(selectionContextMenu.anchorPoint, selectionContextMenuSize.width, selectionContextMenuSize.height)
        : null;
    const selectionSubmenuPosition = selectionSubmenu
        ? positionPopupBeside(selectionSubmenu.anchor, selectionSubmenuSize.width, selectionSubmenuSize.height)
        : null;
    const tablePickerPosition = tablePicker
        ? positionPopupAtPointer(tablePicker.anchorPoint, tablePickerSizeState.width, tablePickerSizeState.height)
        : null;
    const aiPosition = aiSession ? positionPopup(aiSession.snapshot.rect, 360, 420, false) : null;
    const candidatePosition = candidate ? positionPopup(candidate.session.snapshot.rect, 440, 420, false) : null;
    const aiSnapshotCurrent = !aiSnapshotStale;
    const aiNearbyCharacters = aiSession && aiSession.contextScope === 'nearby' && aiSnapshotCurrent && editor
        ? (() => {
            const context = getSameBlockContext(editor, aiSession.snapshot);
            return context.before.length + context.after.length;
        })()
        : 0;
    const dictionaryWord = selectionContextMenu?.snapshot?.selectedText.trim() ?? '';
    const canAddToDictionary = dictionaryWord.length > 0 && dictionaryWord.length <= 80 && !/\s/u.test(dictionaryWord);
    const aiSelection = selectionContextMenu?.snapshot ?? null;
    const aiSelectionWordCount = aiSelection ? countSelectionEditWords(aiSelection.selectedText) : 0;
    const aiSelectionTooLong = aiSelectionWordCount > MAX_SELECTION_EDIT_WORDS;

    const getCurrentContextCommandRange = (): { from: number; to: number } | null => {
        const session = selectionContextMenu;
        if (!editor || !session) return null;
        if (session.editorSessionId !== editorSessionIdRef.current
            || session.currentPath !== currentPath
            || session.docRevision !== docRevisionRef.current) return null;
        const maximum = Math.max(1, editor.state.doc.content.size);
        const from = Math.max(1, Math.min(session.commandRange.from, maximum));
        const to = Math.max(from, Math.min(session.commandRange.to, maximum));
        return { from, to };
    };
    const canRunContextCommand = Boolean(selectionContextMenu);

    const executeSelectionCommand = (command: 'bold' | 'italic' | 'code') => {
        const range = getCurrentContextCommandRange();
        if (isInteractionBlocked || !editor || !range) {
            closeSelectionContextMenu();
            return;
        }
        const chain = editor.chain().focus().setTextSelection(range);
        if (command === 'bold') chain.toggleBold().run();
        if (command === 'italic') chain.toggleItalic().run();
        if (command === 'code') chain.toggleCode().run();
        closeSelectionContextMenu();
    };

    const openSelectionSubmenu = (kind: SelectionSubmenuKind, event: React.MouseEvent<HTMLButtonElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSelectionSubmenu({
            kind,
            anchor: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        });
    };

    const openTablePicker = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!getCurrentContextCommandRange()) {
            closeSelectionContextMenu();
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setSelectionSubmenu(null);
        setTablePicker({
            anchorPoint: { x: rect.right, y: rect.top },
            rows: 3,
            cols: 3,
        });
    };

    const executeSelectionBlockCommand = (transform: BlockTransform) => {
        const range = getCurrentContextCommandRange();
        if (isInteractionBlocked || !editor || !range) {
            closeSelectionContextMenu();
            return;
        }
        const chain = editor.chain().focus().setTextSelection(range);
        switch (transform) {
            case 'paragraph': chain.setParagraph().run(); break;
            case 'heading-1': chain.setHeading({ level: 1 }).run(); break;
            case 'heading-2': chain.setHeading({ level: 2 }).run(); break;
            case 'heading-3': chain.setHeading({ level: 3 }).run(); break;
            case 'heading-4': chain.setHeading({ level: 4 }).run(); break;
            case 'heading-5': chain.setHeading({ level: 5 }).run(); break;
            case 'heading-6': chain.setHeading({ level: 6 }).run(); break;
            case 'blockquote': chain.toggleBlockquote().run(); break;
            case 'bullet-list': chain.toggleBulletList().run(); break;
            case 'ordered-list': chain.toggleOrderedList().run(); break;
            case 'task-list': chain.toggleTaskList().run(); break;
            case 'code-block': chain.toggleCodeBlock().run(); break;
        }
        closeSelectionContextMenu();
    };

    const executeSelectionInsert = (
        kind: 'blockquote' | 'divider' | 'code-block' | 'formula-block' | 'table',
        tableSize?: { rows: number; cols: number },
    ) => {
        const range = getCurrentContextCommandRange();
        if (isInteractionBlocked || !editor || !range) {
            closeSelectionContextMenu();
            return;
        }
        // 引用、代码和公式有内容槽位：应当把右键落点所在文本块的现有内容
        // 转换进去，而不是在旧段落之后再插入一个空块。
        if (kind === 'blockquote') editor.chain().focus().setTextSelection(range).toggleBlockquote().run();
        if (kind === 'code-block') editor.chain().focus().setTextSelection(range).toggleCodeBlock().run();
        if (kind === 'formula-block') editor.chain().focus().setTextSelection(range).setNode('formulaBlock').run();
        // 分割线和表格没有可承载原文的内容槽位，仍在右键目标后新增。
        if (kind === 'divider') editor.chain().focus().setTextSelection({ from: range.to, to: range.to }).setHorizontalRule().run();
        if (kind === 'table') {
            const rows = Math.max(1, Math.min(tablePickerSize, tableSize?.rows ?? 3));
            const cols = Math.max(1, Math.min(tablePickerSize, tableSize?.cols ?? 3));
            editor.chain().focus().setTextSelection({ from: range.to, to: range.to }).insertTable({ rows, cols, withHeaderRow: true }).run();
        }
        closeSelectionContextMenu();
    };

    const executeSelectionLink = () => {
        const range = getCurrentContextCommandRange();
        if (isInteractionBlocked || !editor || !range) {
            closeSelectionContextMenu();
            return;
        }
        onEditLink(range);
        closeSelectionContextMenu();
    };

    const openAiEditingSnapshot = (snapshot: SelectionSnapshot) => {
        cancelActiveRequest();
        setAiSession(createSelectionEditLauncherSession(snapshot));
        setAiSnapshotStale(false);
        setCandidate(null);
        setError(null);
        setAllowStaleRegeneration(false);
        closeSelectionContextMenu();
    };

    const startAiEditing = () => {
        const snapshot = selectionContextMenu?.snapshot;
        if (isInteractionBlocked || !editor || !snapshot || !isCurrent(snapshot)) {
            closeSelectionContextMenu();
            return;
        }
        openAiEditingSnapshot(snapshot);
    };

    const copySelection = async () => {
        const snapshot = selectionContextMenu?.snapshot;
        if (!snapshot || !isCurrent(snapshot)) {
            closeSelectionContextMenu();
            return;
        }
        if (await copyPlainText(snapshot.selectedText)) closeSelectionContextMenu();
        else setSelectionContextFeedback('复制失败，请重试。');
    };

    const cutSelection = async () => {
        const snapshot = selectionContextMenu?.snapshot;
        if (isInteractionBlocked || !editor || !snapshot || !isCurrent(snapshot)) {
            closeSelectionContextMenu();
            return;
        }
        const copied = await copyPlainText(snapshot.selectedText);
        if (!copied) {
            setSelectionContextFeedback('剪切失败，原文没有改动。');
            return;
        }
        if (!isCurrent(snapshot)) {
            closeSelectionContextMenu();
            return;
        }
        editor.chain().focus().setTextSelection({ from: snapshot.from, to: snapshot.to }).deleteSelection().run();
        closeSelectionContextMenu();
    };

    const pasteSelection = async () => {
        const range = getCurrentContextCommandRange();
        if (isInteractionBlocked || !editor || !range) { closeSelectionContextMenu(); return; }
        const doc = editor.state.doc, selection = editor.state.selection;
        const revision = docRevisionRef.current;
        try {
            const data = await window.electronAPI.readClipboardContent();
            if (notePathRef.current !== currentPath || docRevisionRef.current !== revision || editor.isDestroyed || !editor.isEditable || editor.state.doc !== doc || !editor.state.selection.eq(selection) || !getCurrentContextCommandRange()) return;
            const transfer = new DataTransfer();
            transfer.setData('text/plain', data.text); transfer.setData('text/html', data.html);
            if (data.imagePng) transfer.items.add(new File([new Uint8Array(data.imagePng)], 'clipboard.png', { type: 'image/png' }));
            const sources = getClipboardImageSources(transfer);
            const plainWithText = preferences.editorPasteMode === 'plain-text' && (data.text || clipboardPlainText(data).trim());
            if (sources.length && !plainWithText && onSaveImage) {
                const savedImages = [];
                for (const source of sources) savedImages.push(await onSaveImage(source));
                if (notePathRef.current !== currentPath || docRevisionRef.current !== revision || editor.isDestroyed || !editor.isEditable || editor.state.doc !== doc || !editor.state.selection.eq(selection)) return;
                editor.commands.focus(); editor.commands.setTextSelection(range);
                for (const saved of savedImages) editor.chain().setImage({ src: toEditorImageUrl(saved.absolutePath), alt: saved.fileName, relativeSrc: saved.markdownPath } as { src: string }).run();
            } else {
                editor.commands.focus(); editor.commands.setTextSelection(range);
                pasteClipboardText(editor, data, preferences.editorPasteMode);
            }
            closeSelectionContextMenu();
        } catch (error) { setSelectionContextFeedback(error instanceof Error ? error.message : t('无法读取剪贴板，请重试。')); }
    };

    const addSelectionToDictionary = async () => {
        const snapshot = selectionContextMenu?.snapshot;
        const word = snapshot?.selectedText.trim() ?? '';
        if (!snapshot || !isCurrent(snapshot) || !word || word.length > 80 || /\s/u.test(word)) {
            setSelectionContextFeedback('请选择一个不含空格的词。');
            return;
        }
        try {
            const added = await window.electronAPI.addSpellcheckerWord(word);
            if (added) closeSelectionContextMenu();
            else setSelectionContextFeedback('未能添加到系统拼写词典。');
        } catch {
            setSelectionContextFeedback('系统拼写词典当前不可用。');
        }
    };

    const searchSelectionWithGoogle = () => {
        const snapshot = selectionContextMenu?.snapshot;
        if (!snapshot || !isCurrent(snapshot)) {
            closeSelectionContextMenu();
            return;
        }
        const query = snapshot.selectedText.trim().slice(0, 1000);
        window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
        closeSelectionContextMenu();
    };

    const openSelectionExpansion = () => {
        const session = selectionContextMenu;
        if (isInteractionBlocked || !session?.snapshot || !isCurrent(session.snapshot)) {
            closeSelectionContextMenu();
            return;
        }
        onOpenSelectionExpansion?.(session.snapshot);
        closeSelectionContextMenu();
    };

    const closeAiLauncher = () => {
        cancelActiveRequest();
        setAiSession(null);
        setAiSnapshotStale(false);
        setError(null);
        setAllowStaleRegeneration(false);
    };

    const openCurrentSessionExpansion = () => {
        const session = aiSession;
        if (isInteractionBlocked || !session || !isCurrent(session.snapshot)) {
            closeAiLauncher();
            return;
        }
        onOpenSelectionExpansion?.(session.snapshot);
        closeAiLauncher();
    };

    const requestSuggestion = async () => {
        const session = aiSession;
        if (isInteractionBlocked || !editor || !session) return;
        const snapshotCurrent = isCurrent(session.snapshot);
        if (!snapshotCurrent && !allowStaleRegeneration) {
            setError('原文已变化，请重新选择文字后再生成。');
            return;
        }
        if (session.action === 'translate' && !session.targetLanguage.trim()) {
            setError('请填写目标语言。');
            return;
        }
        if (session.action === 'custom' && !session.instruction.trim()) {
            setError('请填写自定义要求。');
            return;
        }

        cancelActiveRequest();
        const requestId = createRequestId();
        activeRequestIdRef.current = requestId;
        setGenerating(true);
        setError(null);
        try {
            const context = session.contextScope === 'nearby' && snapshotCurrent ? getSameBlockContext(editor, session.snapshot) : undefined;
            const usesSavedSource = session.action === 'expand' && session.contextScope !== 'nearby';
            if (usesSavedSource && (!snapshotCurrent || !onPrepareSelectionEditSource)) throw new Error('请重新选择已保存笔记中的文字。');
            const selectionLocator = usesSavedSource ? await createSelectionLocatorCapture(session.snapshot) : undefined;
            const source = usesSavedSource ? await onPrepareSelectionEditSource!(session.snapshot) : undefined;
            if (activeRequestIdRef.current !== requestId) return;
            if (usesSavedSource && !isCurrent(session.snapshot)) throw new Error('原文已变化，请重新选择文字后再生成。');
            const result = await window.electronAPI.startSelectionEdit({
                requestId,
                action: session.action,
                selectedText: session.snapshot.selectedText,
                currentPath,
                contextScope: session.contextScope,
                ...(selectionLocator && source ? { selectionLocator, expectedContentHash: source.contentHash } : {}),
                ...(context ? { context } : {}),
                ...(session.action === 'translate' ? { targetLanguage: session.targetLanguage.trim() } : {}),
                ...(session.action === 'custom' ? { customInstruction: session.instruction.trim() } : {}),
            });
            if (activeRequestIdRef.current !== requestId) return;
            activeRequestIdRef.current = null;
            setGenerating(false);
            setAiSession(null);
            setCandidate({ session, result, stale: !snapshotCurrent || !isCurrent(session.snapshot) });
        } catch (requestError) {
            if (activeRequestIdRef.current !== requestId) return;
            activeRequestIdRef.current = null;
            setGenerating(false);
            setError(toErrorMessage(requestError));
        }
    };

    const applyCandidate = (mode: 'replace' | 'below') => {
        if (isInteractionBlocked || !editor || !candidate) return;
        if (candidate.result.qualityReceipt.validation !== 'passed' || !candidate.result.validation.passed) return;
        if (candidate.stale || !isCurrent(candidate.session.snapshot)) {
            setCandidate((previous) => previous ? { ...previous, stale: true } : null);
            return;
        }
        try {
            if (candidate.session.action === 'expand') {
                if (mode === 'replace') replaceSelectionWithMarkdown(editor, candidate.session.snapshot, candidate.result.text);
                else insertMarkdownBelowSelection(editor, candidate.session.snapshot, candidate.result.text);
            } else {
                if (getSelectionWritebackCapability(candidate.session.snapshot, false).mode === 'copy-only') return;
                if (mode === 'replace') replaceSelectionWithText(editor, candidate.session.snapshot, candidate.result.text);
                else insertTextBelowBlock(editor, candidate.session.snapshot.block, candidate.result.text);
            }
            setCandidate(null);
            setAiSession(null);
        } catch (applyError) {
            setCandidate({ ...candidate, applyError: toErrorMessage(applyError) });
        }
    };

    useEffect(() => {
        if (!editor || !preferences.editorSelectionToolbarEnabled || toolbarBlocked || isInteractionBlocked || !editor.isEditable || selectionContextMenu || aiSession || candidate) {
            setFloatingSnapshot(null); return;
        }
        let frame = 0, dragging = false, dismissed = false;
        const refresh = () => {
            frame = 0;
            const toolbarFocused = document.activeElement?.closest('.selection-floating-toolbar');
            if (dragging || dismissed || editor.view.composing || (!editor.isFocused && !toolbarFocused) || !(editor.state.selection instanceof TextSelection)) { setFloatingSnapshot(null); return; }
            const parent = editor.state.selection.$head.parent;
            if (parent.type.spec.code || ['inlineFormula', 'formulaBlock'].includes(parent.type.name)) { setFloatingSnapshot(null); return; }
            const snapshot = createSelectionExpansionSnapshot({ editor, editorSessionId: editorSessionIdRef.current, currentPath, docRevision: docRevisionRef.current });
            const viewport = editor.view.dom.closest('.editor-viewport')?.getBoundingClientRect();
            setFloatingSnapshot(snapshot && viewport && snapshot.rect.bottom >= viewport.top && snapshot.rect.top <= viewport.bottom ? snapshot : null);
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
        const changed = () => { dismissed = false; cancelAnimationFrame(frame); refresh(); };
        const down = () => { dragging = true; setFloatingSnapshot(null); };
        const up = () => { dragging = false; changed(); };
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) dismissed = true; };
        const viewport = editor.view.dom.closest('.editor-viewport');
        const observer = new ResizeObserver(schedule); observer.observe(editor.view.dom);
        editor.on('selectionUpdate', changed); editor.on('transaction', schedule); editor.on('focus', schedule); editor.on('blur', schedule);
        editor.view.dom.addEventListener('pointerdown', down); editor.view.dom.addEventListener('compositionend', changed); editor.view.dom.addEventListener('compositionstart', schedule);
        document.addEventListener('focusin', schedule);
        window.addEventListener('pointerup', up); window.addEventListener('keydown', escape);
        viewport?.addEventListener('scroll', schedule); window.addEventListener('resize', schedule); schedule();
        return () => {
            cancelAnimationFrame(frame); observer.disconnect();
            editor.off('selectionUpdate', changed); editor.off('transaction', schedule); editor.off('focus', schedule); editor.off('blur', schedule);
            editor.view.dom.removeEventListener('pointerdown', down); editor.view.dom.removeEventListener('compositionend', changed); editor.view.dom.removeEventListener('compositionstart', schedule);
            document.removeEventListener('focusin', schedule);
            window.removeEventListener('pointerup', up); window.removeEventListener('keydown', escape);
            viewport?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
        };
    }, [editor, preferences.editorSelectionToolbarEnabled, toolbarBlocked, isInteractionBlocked, currentPath, selectionContextMenu, aiSession, candidate]);

    const floatingAction = (action: string) => {
        const snapshot = floatingSnapshot;
        if (!editor || !snapshot || !isCurrent(snapshot)) { setFloatingSnapshot(null); return; }
        if (action === 'ai') { if (allowDocumentAi && countSelectionEditWords(snapshot.selectedText) <= MAX_SELECTION_EDIT_WORDS) openAiEditingSnapshot(snapshot); setFloatingSnapshot(null); return; }
        if (action === 'link') { onEditLink({ from: snapshot.from, to: snapshot.to }); setFloatingSnapshot(null); return; }
        const chain = editor.chain().focus().setTextSelection({ from: snapshot.from, to: snapshot.to });
        if (action === 'bold') chain.toggleBold().run();
        if (action === 'italic') chain.toggleItalic().run();
        if (action === 'strike') chain.toggleStrike().run();
        if (action === 'code') chain.toggleCode().run();
    };

    return (
        <>
            {editor && floatingSnapshot && preferences.editorSelectionToolbarEnabled && !toolbarBlocked && !selectionContextMenu && !aiSession && !candidate && <SelectionFloatingToolbar allowDocumentAi={allowDocumentAi} aiDisabledReason={countSelectionEditWords(floatingSnapshot.selectedText) > MAX_SELECTION_EDIT_WORDS ? t("选中文字超过 {0} 词（中文按字计）", { '0': MAX_SELECTION_EDIT_WORDS.toLocaleString(getAppLanguage()) }) : undefined} editor={editor} snapshot={floatingSnapshot} onAction={floatingAction} />}
            {editor && !isInteractionBlocked && selectionContextMenu && selectionContextMenuPosition && (
                <div ref={selectionContextMenuRef} className="selection-block-menu selection-context-menu" style={selectionContextMenuPosition} role="menu" aria-label={t("编辑快捷操作")}>
                    <button type="button" role="menuitem" disabled={!canAddToDictionary} onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={() => void addSelectionToDictionary()} title={!canAddToDictionary ? t("请选择一个不含空格的词") : undefined}><BookPlus size={15} /><span>{t("添加到字典")}</span></button>
                    <div className="selection-overlay-divider" />
                    <button type="button" role="menuitem" disabled={!selectionContextMenu.snapshot} onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={searchSelectionWithGoogle}><Search size={15} /><span>{t("使用 Google 搜索")}</span></button>
                    <div className="selection-overlay-divider" />
                    <button type="button" role="menuitem" disabled={!selectionContextMenu.snapshot} onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={() => void cutSelection()}><Scissors size={15} /><span>{t("剪切")}</span><kbd>Ctrl+X</kbd></button>
                    <button type="button" role="menuitem" disabled={!selectionContextMenu.snapshot} onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={() => void copySelection()}><Copy size={15} /><span>{t("复制")}</span><kbd>Ctrl+C</kbd></button>
                    <button type="button" role="menuitem" onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={() => void pasteSelection()}><ClipboardPaste size={15} /><span>{t("粘贴")}</span><kbd>Ctrl+V</kbd></button>
                    <div className="selection-overlay-divider" />
                    <div className="selection-context-format-grid" role="group" aria-label={t("文字格式")} onMouseEnter={() => setSelectionSubmenu(null)}>
                        <button className={editor.isActive('bold') ? 'active' : ''} type="button" role="menuitem" aria-label={t("粗体")} aria-pressed={editor.isActive('bold')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionCommand('bold')} title={t("粗体 (Ctrl+B)")}><Bold size={20} /></button>
                        <button className={editor.isActive('italic') ? 'active' : ''} type="button" role="menuitem" aria-label={t("斜体")} aria-pressed={editor.isActive('italic')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionCommand('italic')} title={t("斜体 (Ctrl+I)")}><Italic size={20} /></button>
                        <button className={editor.isActive('code') ? 'active' : ''} type="button" role="menuitem" aria-label={t("行内代码")} aria-pressed={editor.isActive('code')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionCommand('code')} title={t("行内代码")}><Code size={20} /></button>
                        <button className={editor.isActive('link') ? 'active' : ''} type="button" role="menuitem" aria-label={t("链接")} aria-pressed={editor.isActive('link')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={executeSelectionLink} title={t("添加或移除链接")}><Link size={20} /></button>
                        <button className={editor.isActive('blockquote') ? 'active' : ''} type="button" role="menuitem" aria-label={t("引用")} aria-pressed={editor.isActive('blockquote')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('blockquote')} title={t("引用")}><Quote size={20} /></button>
                        <button className={editor.isActive('bulletList') ? 'active' : ''} type="button" role="menuitem" aria-label={t("无序列表")} aria-pressed={editor.isActive('bulletList')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('bullet-list')} title={t("无序列表")}><List size={20} /></button>
                        <button className={editor.isActive('orderedList') ? 'active' : ''} type="button" role="menuitem" aria-label={t("有序列表")} aria-pressed={editor.isActive('orderedList')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('ordered-list')} title={t("有序列表")}><ListOrdered size={20} /></button>
                        <button className={editor.isActive('taskList') ? 'active' : ''} type="button" role="menuitem" aria-label={t("待办列表")} aria-pressed={editor.isActive('taskList')} disabled={!canRunContextCommand} onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('task-list')} title={t("待办列表")}><ListChecks size={20} /></button>
                    </div>
                    <div className="selection-overlay-divider" />
                    <button className={selectionSubmenu?.kind === 'paragraph' ? 'active' : ''} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={selectionSubmenu?.kind === 'paragraph'} disabled={!canRunContextCommand} onMouseEnter={(event) => openSelectionSubmenu('paragraph', event)} onMouseDown={preventFocusLoss} onClick={(event) => openSelectionSubmenu('paragraph', event)}><Pilcrow size={15} /><span>{t("段落")}</span><ChevronRight className="selection-context-chevron" size={15} /></button>
                    <button className={selectionSubmenu?.kind === 'insert' ? 'active' : ''} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={selectionSubmenu?.kind === 'insert'} disabled={!canRunContextCommand} onMouseEnter={(event) => openSelectionSubmenu('insert', event)} onMouseDown={preventFocusLoss} onClick={(event) => openSelectionSubmenu('insert', event)}><Table2 size={15} /><span>{t("插入")}</span><ChevronRight className="selection-context-chevron" size={15} /></button>
                    <div className="selection-overlay-divider" />
                    <button className="selection-context-ai-action" type="button" role="menuitem" disabled={!allowDocumentAi || !aiSelection || aiSelectionTooLong} onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={startAiEditing} title={aiSelectionTooLong ? t("选中文字超过 {0} 词（中文按字计）", { '0': MAX_SELECTION_EDIT_WORDS.toLocaleString(getAppLanguage()) }) : !aiSelection ? t("请先选择要编辑的文字") : undefined}><Sparkles size={15} /><span><strong>{t("AI 编辑")}</strong><small>{t("润色、精简、翻译或自定义")}</small></span></button>
                    <button className="selection-context-ai-action" type="button" role="menuitem" disabled={!allowDocumentAi || !selectionContextMenu.snapshot} onMouseEnter={() => setSelectionSubmenu(null)} onMouseDown={preventFocusLoss} onClick={openSelectionExpansion}><Sparkles size={15} /><span><strong>{t("扩写优化")}</strong><small>{t("先查找证据，再生成建议")}</small></span></button>
                    {selectionContextFeedback && <div className="selection-context-menu-status" role="status">{selectionContextFeedback}</div>}
                </div>
            )}

            {editor && !isInteractionBlocked && selectionContextMenu && selectionSubmenu && selectionSubmenuPosition && (
                <div ref={selectionSubmenuRef} className="selection-block-menu selection-context-submenu" style={selectionSubmenuPosition} role="menu" aria-label={selectionSubmenu.kind === 'paragraph' ? t("段落格式") : t("插入内容")}>
                    {selectionSubmenu.kind === 'paragraph' ? (
                        <>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('paragraph')}><Pilcrow size={15} /><span>{t("正文")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('heading-1')}><Heading1 size={15} /><span>{t("标题 1")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('heading-2')}><Heading2 size={15} /><span>{t("标题 2")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('heading-3')}><Heading3 size={15} /><span>{t("标题 3")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('heading-4')}><Heading4 size={15} /><span>{t("标题 4")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('heading-5')}><Heading5 size={15} /><span>{t("标题 5")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionBlockCommand('heading-6')}><Heading6 size={15} /><span>{t("标题 6")}</span></button>
                        </>
                    ) : (
                        <>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionInsert('blockquote')}><Quote size={15} /><span>{t("引用")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionInsert('code-block')}><FileCode2 size={15} /><span>{t("代码块")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionInsert('formula-block')}><Sigma size={15} /><span>{t("公式块")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={() => executeSelectionInsert('divider')}><Minus size={15} /><span>{t("水平分割线")}</span></button>
                            <button type="button" role="menuitem" onMouseDown={preventFocusLoss} onClick={openTablePicker}><Table2 size={15} /><span>{t("表格…")}</span></button>
                        </>
                    )}
                </div>
            )}

            {editor && !isInteractionBlocked && selectionContextMenu && tablePicker && tablePickerPosition && (
                <div ref={tablePickerRef} className="selection-block-menu selection-table-picker" style={tablePickerPosition} role="dialog" aria-label={t("选择表格尺寸")}>
                    <div className="selection-table-picker-header">
                        <strong>{t("插入表格")}</strong>
                        <button type="button" onMouseDown={preventFocusLoss} onClick={() => setTablePicker(null)} aria-label={t("关闭表格尺寸选择")}><X size={15} /></button>
                    </div>
                    <div className="selection-table-picker-size" aria-live="polite">{tablePicker.rows} × {tablePicker.cols}</div>
                    <div className="selection-table-picker-grid" role="grid" aria-label={t("选择表格的行和列")}>
                        {Array.from({ length: tablePickerSize }, (_, rowIndex) => (
                            Array.from({ length: tablePickerSize }, (_, colIndex) => {
                                const rows = rowIndex + 1;
                                const cols = colIndex + 1;
                                const selected = rows <= tablePicker.rows && cols <= tablePicker.cols;
                                return (
                                    <button
                                        key={`${rows}-${cols}`}
                                        className={selected ? 'active' : ''}
                                        type="button"
                                        role="gridcell"
                                        aria-label={t("选择 {0} 行 {1} 列表格", { '0': rows, '1': cols })}
                                        aria-pressed={selected}
                                        onMouseDown={preventFocusLoss}
                                        onMouseEnter={() => setTablePicker((previous) => previous ? { ...previous, rows, cols } : previous)}
                                        onFocus={() => setTablePicker((previous) => previous ? { ...previous, rows, cols } : previous)}
                                        onClick={() => executeSelectionInsert('table', { rows, cols })}
                                    />
                                );
                            })
                        ))}
                    </div>
                    <small>{t("移动到格子上预览，点击后插入")}</small>
                </div>
            )}

            {allowDocumentAi && editor && !isInteractionBlocked && aiSession && aiPosition && (
                <SelectionEditLauncher
                    position={aiPosition}
                    selectedCharacters={aiSession.snapshot.selectedText.length}
                    nearbyCharacters={aiNearbyCharacters}
                    snapshotCurrent={aiSnapshotCurrent}
                    action={aiSession.action}
                    contextScope={aiSession.contextScope}
                    targetLanguage={aiSession.targetLanguage}
                    instruction={aiSession.instruction}
                    generating={generating}
                    error={error}
                    actions={quickActions}
                    onActionChange={(nextAction) => setAiSession((previous) => previous ? { ...previous, action: nextAction } : previous)}
                    onContextScopeChange={(nextScope) => setAiSession((previous) => previous ? { ...previous, contextScope: nextScope } : previous)}
                    onTargetLanguageChange={(value) => setAiSession((previous) => previous ? { ...previous, targetLanguage: value } : previous)}
                    onInstructionChange={(value) => setAiSession((previous) => previous ? { ...previous, instruction: value } : previous)}
                    onGenerate={() => void requestSuggestion()}
                    onCancel={closeAiLauncher}
                    onOpenEvidenceWorkspace={onOpenSelectionExpansion ? openCurrentSessionExpansion : undefined}
                    onPreserveSelection={preventFocusLoss}
                />
            )}

            {editor && !isInteractionBlocked && candidate && candidatePosition && (
                <SelectionEditSuggestion
                    position={candidatePosition}
                    selectedText={candidate.session.snapshot.selectedText}
                    suggestion={candidate.result.text}
                    markdown={candidate.session.action === 'expand'}
                    selectedMarkdown={candidate.session.snapshot.structure.markdownFragment}
                    contextReceipt={candidate.result.contextReceipt}
                    qualityReceipt={candidate.result.qualityReceipt}
                    stale={candidate.stale}
                    replaceDisabledMessage={getSelectionWritebackCapability(candidate.session.snapshot, candidate.session.action === 'expand').mode === 'copy-only'
                        ? getSelectionWritebackCapability(candidate.session.snapshot, candidate.session.action === 'expand').message
                        : undefined}
                    applyDisabledMessage={candidate.applyError ? candidate.applyError : getSelectionWritebackCapability(candidate.session.snapshot, candidate.session.action === 'expand').mode === 'copy-only'
                        ? getSelectionWritebackCapability(candidate.session.snapshot, candidate.session.action === 'expand').message
                        : candidate.result.suggestedApplyMode === 'copy-only' || candidate.result.qualityReceipt.validation !== 'passed'
                        ? (primarySelectionEditQualityIssue(candidate.result.qualityReceipt)
                          ? selectionEditQualityIssueLabel(primarySelectionEditQualityIssue(candidate.result.qualityReceipt)!)
                          : candidate.result.validation.warnings[0]
                          ?? candidate.result.validation.protectedAnchorLosses[0]
                          ?? candidate.result.validation.unsupportedClaims[0]
                          ?? t("该建议缺少可直接写回的验证结果，请复制后人工核对。"))
                        : undefined}
                    onClose={() => setCandidate(null)}
                    onCopy={() => void copyPlainText(candidate.result.text)}
                    onRegenerate={() => {
                        setCandidate(null);
                        setAiSession(candidate.session);
                        setAiSnapshotStale(candidate.stale);
                        setError(null);
                        setAllowStaleRegeneration(candidate.stale);
                    }}
                    onInsertBelow={() => applyCandidate('below')}
                    onReplace={() => applyCandidate('replace')}
                    onPreserveSelection={preventFocusLoss}
                />
            )}
        </>
    );
}
