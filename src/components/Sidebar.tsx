import { t, useI18n } from '../i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Button } from '@mantine/core';
import {
    ChevronDown,
    ChevronRight,
    FileCode2,
    FileText,
    Folder,
    FolderPlus,
    Import,
    ListTree,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    RefreshCw,
    Search,
    Star,
    Tags,
    Trash2,
    Edit2,
    Ellipsis,
    Pin,
} from 'lucide-react';
import type { FileNode, HeadingEntry } from '../electron';
import type { LibrarySummary } from '../electron';
import LibrarySwitcher from './LibrarySwitcher';
import NoteLibraryContextMenu, { type NoteLibraryMenuTarget } from './NoteLibraryContextMenu';
import NoteOverviewModal, { type NoteOverviewData } from './NoteOverviewModal';
import { getEditableEntryName, getSidebarDisplayName } from '../utils/sidebarDisplay';
import { collapseAllFolders, collapseExceptCurrentPath, collectDirectoryPaths, getAncestorFolderPaths, reconcileCollapsedFolderPaths } from '../utils/fileTreeState';
import { buildOutlineTree, collectCollapsibleOutlineKeys, flattenVisibleOutlineTree } from '../utils/outline';

export type LeftPanelMode = 'files' | 'outline';

interface DragPayload {
    path: string;
    parentPath: string | null;
    isDirectory: boolean;
}

interface SidebarProps {
    files: FileNode[];
    currentPath: string | null;
    libraryPath: string | null;
    libraries: LibrarySummary[];
    headings: HeadingEntry[];
    favoritePaths: string[];
    pinnedEntryPaths: string[];
    entryActionsDisabled: boolean;
    onDialogOpenedChange: (opened: boolean) => void;
    collapsedFolderPaths: string[];
    mode: LeftPanelMode;
    isCollapsed: boolean;
    width: number;
    onSetMode: (mode: LeftPanelMode) => void;
    onToggleCollapse: () => void;
    onWidthChange: (width: number) => void;
    onSelectFile: (path: string) => void;
    onCreateFile: (parentDirectoryPath?: string | null) => void;
    onCreateFolder: (parentDirectoryPath?: string | null) => void;
    onImportFiles: (targetDirectoryPath?: string | null) => void;
    onActivateLibrary: (libraryPath: string) => void;
    onAddLibrary: () => void;
    onOpenLibraries: () => void;
    onOpenSearch: () => void;
    onOpenTags: () => void;
    onRefresh: () => void;
    onRename: (path: string, newName: string) => Promise<boolean | void> | void;
    onDelete: (path: string, isDirectory: boolean) => void;
    onMoveEntry: (sourcePath: string, targetDirectoryPath: string) => Promise<string | null>;
    onSaveTreeOrder: (parentDirectoryPath: string, orderedChildPaths: string[]) => Promise<boolean>;
    onJumpToHeading: (heading: HeadingEntry) => void;
    onToggleFavorite: (path: string) => void;
    onTogglePinned: (path: string) => Promise<void>;
    onLoadNoteOverview: (path: string) => Promise<NoteOverviewData>;
    onSetCollapsedFolderPaths: (paths: string[]) => void;
}

interface FileTreeNodeProps {
    node: FileNode;
    level: number;
    parentPath: string | null;
    siblingPaths: string[];
    libraryPath: string | null;
    currentPath: string | null;
    favoritePaths: Set<string>;
    pinnedPaths: Set<string>;
    expandedPaths: Set<string>;
    onToggleExpanded: (path: string) => void;
    onSelect: (path: string) => void;
    onCreateFile: (parentDirectoryPath?: string | null) => void;
    onCreateFolder: (parentDirectoryPath?: string | null) => void;
    onImportFiles: (targetDirectoryPath?: string | null) => void;
    onRename: (path: string, newName: string) => void;
    onDelete: (path: string, isDirectory: boolean) => void;
    onMoveEntry: (sourcePath: string, targetDirectoryPath: string) => Promise<string | null>;
    onSaveTreeOrder: (parentDirectoryPath: string, orderedChildPaths: string[]) => Promise<boolean>;
    onToggleFavorite: (path: string) => void;
    onOpenContextMenu: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, node: FileNode) => void;
}

const iconButtonStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
};

const minimumSidebarWidth = 200;
const maximumSidebarWidth = 520;
const minimumEditorAndPanelWidth = 464;

function getAvailableSidebarWidth(): number {
    return Math.max(minimumSidebarWidth, Math.min(maximumSidebarWidth, window.innerWidth - minimumEditorAndPanelWidth));
}

function constrainSidebarWidth(width: number): number {
    return Math.max(minimumSidebarWidth, Math.min(getAvailableSidebarWidth(), width));
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
    node,
    level,
    parentPath,
    siblingPaths,
    libraryPath,
    currentPath,
    favoritePaths,
    pinnedPaths,
    expandedPaths,
    onToggleExpanded,
    onSelect,
    onCreateFile,
    onCreateFolder,
    onImportFiles,
    onRename,
    onDelete,
    onMoveEntry,
    onSaveTreeOrder,
    onToggleFavorite,
    onOpenContextMenu,
}) => {
  useI18n();
    const [isEditing, setIsEditing] = useState(false);
    const [editName, setEditName] = useState(getEditableName(node));
    const [dropIntent, setDropIntent] = useState<'before' | 'inside' | 'after' | null>(null);
    const isExpanded = expandedPaths.has(node.path);
    const isSelected = currentPath === node.path;
    const paddingLeft = 10 + level * 14;

    const submitRename = () => {
        setIsEditing(false);
        const finalName = editName.trim();
        if (finalName && finalName !== getEditableName(node)) {
            onRename(node.path, finalName);
        } else {
            setEditName(getEditableName(node));
        }
    };

    const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
        if (isEditing) return;
        event.preventDefault();
        event.stopPropagation();
        setDropIntent(null);

        if (!libraryPath) return;
        const payload = getDragPayload(event);
        if (!payload || payload.path === node.path) return;

        const intent = getDropIntent(event, node);
        if (intent === 'inside' && node.isDirectory) {
            await onMoveEntry(payload.path, node.path);
            return;
        }

        const targetParentPath = parentPath ?? libraryPath;
        const sourceParentPath = payload.parentPath ?? libraryPath;
        const movedPath = sourceParentPath === targetParentPath
            ? payload.path
            : await onMoveEntry(payload.path, targetParentPath);
        if (!movedPath) return;

        const nextOrder = siblingPaths.filter((path) => path !== payload.path && path !== movedPath);
        const targetIndex = nextOrder.indexOf(node.path);
        const insertIndex = intent === 'after' ? targetIndex + 1 : targetIndex;
        nextOrder.splice(Math.max(insertIndex, 0), 0, movedPath);
        await onSaveTreeOrder(targetParentPath, nextOrder);
    };

    return (
        <>
            <div
                className={`sidebar-item file-tree-row ${isSelected ? 'selected' : ''} ${dropIntent ? `drop-${dropIntent}` : ''}`}
                data-path={node.path}
                onContextMenu={(event) => { if (!isEditing) onOpenContextMenu(event, node); }}
                draggable={!isEditing}
                onDragStart={(event) => {
                    if (isEditing) {
                        event.preventDefault();
                        return;
                    }
                    const payload: DragPayload = { path: node.path, parentPath, isDirectory: node.isDirectory };
                    event.dataTransfer.setData('application/x-menghan-entry', JSON.stringify(payload));
                    event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                    if (isEditing) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropIntent(getDropIntent(event, node));
                }}
                onDragLeave={() => setDropIntent(null)}
                onDrop={handleDrop}
                onClick={() => {
                    if (isEditing) return;
                    if (node.isDirectory) {
                        onToggleExpanded(node.path);
                    } else {
                        onSelect(node.path);
                    }
                }}
                onKeyDown={(event) => {
                    if (isEditing) return;
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        onOpenContextMenu(event, node);
                        return;
                    }
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        if (node.isDirectory) onToggleExpanded(node.path);
                        else onSelect(node.path);
                    }
                    if (node.isDirectory && event.key === 'ArrowLeft' && isExpanded) {
                        event.preventDefault();
                        onToggleExpanded(node.path);
                    }
                    if (node.isDirectory && event.key === 'ArrowRight' && !isExpanded) {
                        event.preventDefault();
                        onToggleExpanded(node.path);
                    }
                }}
                role="treeitem"
                aria-expanded={node.isDirectory ? isExpanded : undefined}
                aria-selected={isSelected}
                aria-haspopup="menu"
                tabIndex={0}
                style={{ paddingLeft }}
            >
                {node.isDirectory ? (
                    <button
                        type="button"
                        className="tree-chevron"
                        aria-label={isExpanded ? t("收起 {0}", { '0': node.name }) : t("展开 {0}", { '0': node.name })}
                        onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.path); }}
                    >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                ) : null}
                {node.isDirectory ? (
                    <Folder size={15} className="tree-icon" />
                ) : node.kind === 'text' ? (
                    <FileCode2 size={15} className="tree-icon" />
                ) : (
                    <FileText size={15} className="tree-icon" />
                )}
                {isEditing ? (
                    <input
                        autoFocus
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') submitRename();
                            if (event.key === 'Escape') {
                                setIsEditing(false);
                                setEditName(getEditableName(node));
                            }
                        }}
                        onBlur={submitRename}
                        onClick={(event) => event.stopPropagation()}
                        className="tree-rename-input"
                    />
                ) : (
                    <>
                        <span className="tree-label" title={node.name}>{getSidebarDisplayName(node)}</span>
                        {!node.isDirectory && node.kind === 'text' ? (
                            <span className="tree-extension">{node.extension?.replace('.', '')}</span>
                        ) : null}
                        {pinnedPaths.has(node.path) ? <Pin size={11} className="tree-pin-icon" aria-label={t("已置顶")} /> : null}
                        <div className="item-actions">
                            {!node.isDirectory ? (
                                <button title={favoritePaths.has(node.path) ? t("取消收藏") : t("收藏")} style={iconButtonStyle} onClick={(event) => { event.stopPropagation(); onToggleFavorite(node.path); }}>
                                    <Star size={12} fill={favoritePaths.has(node.path) ? 'currentColor' : 'none'} />
                                </button>
                            ) : null}
                            {node.isDirectory ? (
                                <>
                                    <button title={t("在此新建笔记")} style={iconButtonStyle} onClick={(event) => { event.stopPropagation(); onCreateFile(node.path); }}>
                                        <Plus size={12} />
                                    </button>
                                    <button title={t("新建子文件夹")} style={iconButtonStyle} onClick={(event) => { event.stopPropagation(); onCreateFolder(node.path); }}>
                                        <FolderPlus size={12} />
                                    </button>
                                    <button title={t("导入到此文件夹")} style={iconButtonStyle} onClick={(event) => { event.stopPropagation(); onImportFiles(node.path); }}>
                                        <Import size={12} />
                                    </button>
                                </>
                            ) : null}
                            <button title={t("重命名")} style={iconButtonStyle} onClick={(event) => { event.stopPropagation(); setDropIntent(null); setEditName(getEditableName(node)); setIsEditing(true); }}>
                                <Edit2 size={12} />
                            </button>
                            <button title={t("删除")} style={iconButtonStyle} onClick={(event) => { event.stopPropagation(); onDelete(node.path, node.isDirectory); }}>
                                <Trash2 size={12} />
                            </button>
                        </div>
                    </>
                )}
            </div>
            {node.isDirectory && isExpanded ? (
                <FileTree
                    nodes={node.children ?? []}
                    level={level + 1}
                    parentPath={node.path}
                    libraryPath={libraryPath}
                    currentPath={currentPath}
                    favoritePaths={favoritePaths}
                    pinnedPaths={pinnedPaths}
                    expandedPaths={expandedPaths}
                    onToggleExpanded={onToggleExpanded}
                    onSelect={onSelect}
                    onCreateFile={onCreateFile}
                    onCreateFolder={onCreateFolder}
                    onImportFiles={onImportFiles}
                    onRename={onRename}
                    onDelete={onDelete}
                    onMoveEntry={onMoveEntry}
                    onSaveTreeOrder={onSaveTreeOrder}
                    onToggleFavorite={onToggleFavorite}
                    onOpenContextMenu={onOpenContextMenu}
                />
            ) : null}
        </>
    );
};

const FileTree: React.FC<Omit<FileTreeNodeProps, 'node' | 'siblingPaths'> & { nodes: FileNode[] }> = ({
    nodes,
    ...props
}) => {
  useI18n();
    const siblingPaths = useMemo(() => nodes.map((node) => node.path), [nodes]);
    return (
        <>
            {nodes.map((node) => (
                <FileTreeNode
                    key={node.path}
                    node={node}
                    siblingPaths={siblingPaths}
                    {...props}
                />
            ))}
        </>
    );
};

const OutlinePanel: React.FC<{
    headings: HeadingEntry[];
    collapsedKeys: string[];
    onCollapsedKeysChange: (keys: string[]) => void;
    onJumpToHeading: (heading: HeadingEntry) => void;
    onCloseOutline: () => void;
}> = ({ headings, collapsedKeys, onCollapsedKeysChange, onJumpToHeading, onCloseOutline }) => {
  useI18n();
    const tree = useMemo(() => buildOutlineTree(headings), [headings]);
    const collapsibleKeys = useMemo(() => collectCollapsibleOutlineKeys(tree), [tree]);
    const collapsibleSet = useMemo(() => new Set(collapsibleKeys), [collapsibleKeys]);
    const reconciledKeys = useMemo(
        () => collapsedKeys.filter((key) => collapsibleSet.has(key)),
        [collapsedKeys, collapsibleSet],
    );
    const collapsedSet = useMemo(() => new Set(reconciledKeys), [reconciledKeys]);
    const visibleRows = useMemo(() => flattenVisibleOutlineTree(tree, collapsedSet), [collapsedSet, tree]);
    const hasCollapsedHeadings = reconciledKeys.length > 0;

    useEffect(() => {
        if (!samePaths(reconciledKeys, collapsedKeys)) onCollapsedKeysChange(reconciledKeys);
    }, [collapsedKeys, onCollapsedKeysChange, reconciledKeys]);

    const toggleHeading = (key: string) => {
        const next = new Set(collapsedSet);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onCollapsedKeysChange([...next]);
    };

    return (
        <div className="outline-panel">
            <div className="sidebar-section-header">
                <span>{t("当前目录")}</span>
                <div style={{ display: 'flex', gap: 2 }}>
                    <button title={t("返回文件")} style={iconButtonStyle} onClick={onCloseOutline}>
                        <FileText size={14} />
                    </button>
                    <button
                        type="button"
                        className="outline-all-toggle"
                        title={hasCollapsedHeadings ? t("全部展开") : t("全部收起")}
                        aria-label={hasCollapsedHeadings ? t("全部展开目录") : t("全部收起目录")}
                        style={iconButtonStyle}
                        disabled={collapsibleKeys.length === 0}
                        onClick={() => onCollapsedKeysChange(hasCollapsedHeadings ? [] : collapsibleKeys)}
                    >
                        {hasCollapsedHeadings ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                </div>
            </div>
            {headings.length > 0 ? (
                <>
                    <div className="outline-list" role="tree" aria-label={t("当前笔记目录")}>
                        {visibleRows.map((row) => (
                            <div
                                key={row.key}
                                className="outline-row"
                                role="treeitem"
                                aria-level={row.depth + 1}
                                aria-expanded={row.hasChildren ? !row.isCollapsed : undefined}
                                style={{ paddingLeft: 4 + row.depth * 12 }}
                            >
                                {row.hasChildren ? (
                                    <button
                                        type="button"
                                        className="outline-toggle"
                                        aria-label={t("{0}“{1}”的子标题", { '0': row.isCollapsed ? t("展开") : t("收起"), '1': row.heading.text })}
                                        title={row.isCollapsed ? t("展开子标题") : t("收起子标题")}
                                        onClick={() => toggleHeading(row.key)}
                                    >
                                        {row.isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                                    </button>
                                ) : (
                                    <span className="outline-toggle-placeholder" aria-hidden="true" />
                                )}
                                <button
                                    type="button"
                                    className="outline-link"
                                    title={row.heading.text}
                                    onClick={() => onJumpToHeading(row.heading)}
                                >
                                    {row.heading.text}
                                </button>
                            </div>
                        ))}
                    </div>
                </>
            ) : (
                <div className="sidebar-empty">{t("当前文件没有可显示的 Markdown 标题")}</div>
            )}
        </div>
    );
};

const Sidebar: React.FC<SidebarProps> = ({
    files,
    currentPath,
    libraryPath,
    libraries,
    headings,
    favoritePaths,
    pinnedEntryPaths,
    entryActionsDisabled,
    onDialogOpenedChange,
    collapsedFolderPaths,
    mode,
    isCollapsed,
    width,
    onSetMode,
    onToggleCollapse,
    onWidthChange,
    onSelectFile,
    onCreateFile,
    onCreateFolder,
    onImportFiles,
    onActivateLibrary,
    onAddLibrary,
    onOpenLibraries,
    onOpenSearch,
    onOpenTags,
    onRefresh,
    onRename,
    onDelete,
    onMoveEntry,
    onSaveTreeOrder,
    onJumpToHeading,
    onToggleFavorite,
    onTogglePinned,
    onLoadNoteOverview,
    onSetCollapsedFolderPaths,
}) => {
  useI18n();
    const [isTreeMenuOpen, setIsTreeMenuOpen] = useState(false);
    const [contextMenu, setContextMenu] = useState<NoteLibraryMenuTarget | null>(null);
    const [overviewNode, setOverviewNode] = useState<FileNode | null>(null);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const closeContextMenu = useCallback(() => setContextMenu(null), []);
    const pinnedSet = useMemo(() => new Set(pinnedEntryPaths), [pinnedEntryPaths]);
    const orderedFiles = useMemo(() => sortPinnedEntries(files, pinnedSet), [files, pinnedSet]);
    const treeMenuAnchorRef = useRef<HTMLDivElement>(null);
    const widthRef = useRef(width);
    const preferredWidthRef = useRef(width);
    const [sidebarWidth, setSidebarWidth] = useState(width);
    const [collapsedOutlineKeysByPath, setCollapsedOutlineKeysByPath] = useState<Record<string, string[]>>({});
    const lastAutoExpandedPathRef = useRef<string | null>(null);
    const directoryPaths = useMemo(() => collectDirectoryPaths(files), [files]);
    const collapsedSet = useMemo(() => new Set(collapsedFolderPaths), [collapsedFolderPaths]);
    const expandedPaths = useMemo(() => new Set(directoryPaths.filter((path) => !collapsedSet.has(path))), [collapsedSet, directoryPaths]);
    const favoriteSet = useMemo(() => new Set(favoritePaths), [favoritePaths]);
    const favoriteFiles = useMemo(() => flattenFiles(files).filter((node) => favoriteSet.has(node.path)), [favoriteSet, files]);
    const collapsedOutlineKeys = currentPath ? (collapsedOutlineKeysByPath[currentPath] ?? []) : [];

    useEffect(() => {
        onDialogOpenedChange(Boolean(overviewNode) || renameDialogOpen);
        return () => onDialogOpenedChange(false);
    }, [onDialogOpenedChange, overviewNode, renameDialogOpen]);

    useEffect(() => {
        setContextMenu(null);
        setOverviewNode(null);
    }, [libraryPath, isCollapsed]);

    // 右键仅打开目标菜单；不会切换编辑中的笔记或折叠文件夹。
    const openContextMenu = useCallback((event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, node: FileNode) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = 'clientX' in event ? event.clientX : rect.left + 24;
        const y = 'clientY' in event ? event.clientY : rect.bottom;
        setIsTreeMenuOpen(false);
        setContextMenu({ node, x, y });
    }, []);

    useEffect(() => {
        if (!isTreeMenuOpen) return undefined;

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && treeMenuAnchorRef.current?.contains(target)) return;
            setIsTreeMenuOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsTreeMenuOpen(false);
        };

        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isTreeMenuOpen]);

    useEffect(() => {
        preferredWidthRef.current = width;
        const nextWidth = constrainSidebarWidth(width);
        widthRef.current = nextWidth;
        setSidebarWidth(nextWidth);
    }, [width]);

    useEffect(() => {
        const handleWindowResize = () => {
            const nextWidth = constrainSidebarWidth(preferredWidthRef.current);
            widthRef.current = nextWidth;
            setSidebarWidth(nextWidth);
        };
        window.addEventListener('resize', handleWindowResize);
        handleWindowResize();
        return () => window.removeEventListener('resize', handleWindowResize);
    }, []);

    const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = widthRef.current;
        const handlePointerMove = (moveEvent: PointerEvent) => {
            const nextWidth = constrainSidebarWidth(startWidth + moveEvent.clientX - startX);
            widthRef.current = nextWidth;
            preferredWidthRef.current = nextWidth;
            setSidebarWidth(nextWidth);
        };
        const finishResize = () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', finishResize);
            window.removeEventListener('pointercancel', finishResize);
            window.removeEventListener('blur', finishResize);
            document.body.classList.remove('resizing-left-sidebar');
            onWidthChange(widthRef.current);
        };
        document.body.classList.add('resizing-left-sidebar');
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', finishResize, { once: true });
        window.addEventListener('pointercancel', finishResize, { once: true });
        window.addEventListener('blur', finishResize, { once: true });
    };

    const setCollapsedOutlineKeys = useCallback((keys: string[]) => {
        if (!currentPath) return;
        setCollapsedOutlineKeysByPath((current) => {
            if (samePaths(current[currentPath] ?? [], keys)) return current;
            return { ...current, [currentPath]: keys };
        });
    }, [currentPath]);

    const toggleExpanded = (path: string) => {
        const next = new Set(collapsedSet);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        onSetCollapsedFolderPaths(reconcileCollapsedFolderPaths(files, next));
    };

    useEffect(() => {
        const reconciled = reconcileCollapsedFolderPaths(files, collapsedFolderPaths);
        if (!samePaths(reconciled, collapsedFolderPaths)) onSetCollapsedFolderPaths(reconciled);
    }, [collapsedFolderPaths, files, onSetCollapsedFolderPaths]);

    useEffect(() => {
        lastAutoExpandedPathRef.current = null;
        setCollapsedOutlineKeysByPath({});
    }, [libraryPath]);

    useEffect(() => {
        if (!currentPath || lastAutoExpandedPathRef.current === currentPath) return;
        lastAutoExpandedPathRef.current = currentPath;
        const ancestors = new Set(getAncestorFolderPaths(files, currentPath));
        if (ancestors.size === 0) return;
        const next = collapsedFolderPaths.filter((folderPath) => !ancestors.has(folderPath));
        if (!samePaths(next, collapsedFolderPaths)) onSetCollapsedFolderPaths(next);
    }, [collapsedFolderPaths, currentPath, files, onSetCollapsedFolderPaths]);

    const handleRootDrop = async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (!libraryPath) return;
        const payload = getDragPayload(event);
        if (!payload || payload.parentPath === null) return;
        await onMoveEntry(payload.path, libraryPath);
    };

    if (isCollapsed) {
        return (
            <aside className="sidebar sidebar-collapsed">
                <ActionIcon title={t("展开侧栏")} aria-label={t("展开侧栏")} variant="subtle" color="gray" size="md" onClick={onToggleCollapse}>
                    <PanelLeftOpen size={16} />
                </ActionIcon>
                <ActionIcon title={t("搜索")} aria-label={t("搜索")} variant="subtle" color="gray" size="md" onClick={onOpenSearch}>
                    <Search size={16} />
                </ActionIcon>
                <ActionIcon title={t("文件")} aria-label={t("文件")} variant="subtle" color="gray" size="md" onClick={() => { onSetMode('files'); onToggleCollapse(); }}>
                    <FileText size={16} />
                </ActionIcon>
                <ActionIcon title={t("目录")} aria-label={t("目录")} variant="subtle" color="gray" size="md" onClick={() => { onSetMode('outline'); onToggleCollapse(); }}>
                    <ListTree size={16} />
                </ActionIcon>
            </aside>
        );
    }

    return (
        <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
            <div className="sidebar-resizer" role="separator" aria-label={t("调整左侧栏宽度")} aria-orientation="vertical" onPointerDown={startResize} />
            <div className="sidebar-library-header">
                <LibrarySwitcher
                    libraries={libraries}
                    activeLibraryPath={libraryPath}
                    onActivate={onActivateLibrary}
                    onAddLibrary={onAddLibrary}
                    onOpenLibraries={onOpenLibraries}
                />
                <ActionIcon title={t("收起侧栏")} aria-label={t("收起侧栏")} variant="subtle" color="gray" size="md" style={{ marginLeft: 'auto' }} onClick={onToggleCollapse}>
                    <PanelLeftClose size={15} />
                </ActionIcon>
            </div>

            <div className="sidebar-tabs">
                <Button className={mode === 'files' ? 'active' : ''} variant={mode === 'files' ? 'light' : 'subtle'} color={mode === 'files' ? 'brand' : 'gray'} size="sm" fullWidth leftSection={<FileText size={14} />} onClick={() => onSetMode('files')}>
                    {t("文件")}
                </Button>
                <Button className={mode === 'outline' ? 'active' : ''} variant={mode === 'outline' ? 'light' : 'subtle'} color={mode === 'outline' ? 'brand' : 'gray'} size="sm" fullWidth leftSection={<ListTree size={14} />} onClick={() => onSetMode('outline')}>
                    {t("目录")}
                </Button>
            </div>

            <Button className="sidebar-command" variant="subtle" color="gray" size="sm" fullWidth justify="flex-start" leftSection={<Search size={14} />} onClick={onOpenSearch}>
                <span>{t("搜索")}</span>
                <span className="shortcut">Ctrl+K</span>
            </Button>

            <div className="sidebar-body" onScroll={closeContextMenu} onDragOver={(event) => event.preventDefault()} onDrop={handleRootDrop}>
                {mode === 'outline' ? (
                    <OutlinePanel
                        headings={headings}
                        collapsedKeys={collapsedOutlineKeys}
                        onCollapsedKeysChange={setCollapsedOutlineKeys}
                        onJumpToHeading={onJumpToHeading}
                        onCloseOutline={() => onSetMode('files')}
                    />
                ) : (
                    <>
                        {favoriteFiles.length > 0 && (
                            <>
                                <div className="sidebar-section-header"><span>{t("收藏")}</span></div>
                                {favoriteFiles.map((node) => (
                                    <button key={`favorite-${node.path}`} className={`sidebar-item favorite-item ${currentPath === node.path ? 'selected' : ''}`} onClick={() => onSelectFile(node.path)}
                                        onContextMenu={(event) => openContextMenu(event, node)} aria-haspopup="menu"
                                        onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openContextMenu(event, node); }}>
                                        <Star size={14} fill="currentColor" />
                                        <span className="tree-label" title={node.name}>{getSidebarDisplayName(node)}</span>
                                    </button>
                                ))}
                            </>
                        )}
                        <div className="sidebar-section-header tree-section-header">
                            <span>{t("笔记库")}</span>
                            <div className="tree-section-actions">
                                <button title={t("导入到根目录")} style={iconButtonStyle} onClick={() => onImportFiles(null)}>
                                    <Import size={14} />
                                </button>
                                <div className="tree-menu-anchor" ref={treeMenuAnchorRef}>
                                    <button title={t("目录树选项")} aria-haspopup="menu" aria-expanded={isTreeMenuOpen} style={iconButtonStyle} onClick={() => setIsTreeMenuOpen((open) => !open)}>
                                        <Ellipsis size={15} />
                                    </button>
                                    {isTreeMenuOpen ? (
                                        <div className="tree-menu" role="menu">
                                            <button role="menuitem" onClick={() => { onSetCollapsedFolderPaths([]); setIsTreeMenuOpen(false); }}>{t("全部展开")}</button>
                                            <button role="menuitem" onClick={() => { onSetCollapsedFolderPaths(collapseAllFolders(files)); setIsTreeMenuOpen(false); }}>{t("全部收起")}</button>
                                            <button role="menuitem" disabled={!currentPath} onClick={() => { onSetCollapsedFolderPaths(collapseExceptCurrentPath(files, currentPath)); setIsTreeMenuOpen(false); }}>{t("仅展开当前笔记路径")}</button>
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                        {files.length === 0 ? (
                            <div className="sidebar-empty">{t("没有找到可读取的笔记文件")}</div>
                        ) : (
                            <FileTree
                                nodes={orderedFiles}
                                level={0}
                                parentPath={null}
                                libraryPath={libraryPath}
                                currentPath={currentPath}
                                favoritePaths={favoriteSet}
                                pinnedPaths={pinnedSet}
                                expandedPaths={expandedPaths}
                                onToggleExpanded={toggleExpanded}
                                onSelect={onSelectFile}
                                onCreateFile={onCreateFile}
                                onCreateFolder={onCreateFolder}
                                onImportFiles={onImportFiles}
                                onRename={onRename}
                                onDelete={onDelete}
                                onMoveEntry={onMoveEntry}
                                onSaveTreeOrder={onSaveTreeOrder}
                                onToggleFavorite={onToggleFavorite}
                                onOpenContextMenu={openContextMenu}
                            />
                        )}
                    </>
                )}
            </div>

            <div className="sidebar-bottom">
                <Button className="sidebar-command" variant="subtle" color="gray" size="sm" fullWidth justify="flex-start" leftSection={<Plus size={14} />} onClick={() => onCreateFile(null)}>
                    {t("新建笔记")}
                </Button>
                <Button className="sidebar-command" variant="subtle" color="gray" size="sm" fullWidth justify="flex-start" leftSection={<FolderPlus size={14} />} onClick={() => onCreateFolder(null)}>
                    {t("新建文件夹")}
                </Button>
                <Button className="sidebar-command" variant="subtle" color="gray" size="sm" fullWidth justify="flex-start" leftSection={<Import size={14} />} onClick={() => onImportFiles(null)}>
                    {t("导入文件")}
                </Button>
                <Button className="sidebar-command" variant="subtle" color="gray" size="sm" fullWidth justify="flex-start" leftSection={<RefreshCw size={14} />} onClick={onRefresh}>
                    {t("刷新")}
                </Button>
                <Button className="sidebar-command" variant="subtle" color="gray" size="sm" fullWidth justify="flex-start" leftSection={<Tags size={14} />} onClick={onOpenTags}>
                    {t("标签")}
                </Button>
            </div>
            <NoteLibraryContextMenu key={libraryPath} target={contextMenu}
                entryActionsDisabled={entryActionsDisabled} onRenameDialogChange={setRenameDialogOpen}
                pinned={Boolean(contextMenu && pinnedSet.has(contextMenu.node.path))}
                favorite={Boolean(contextMenu && favoriteSet.has(contextMenu.node.path))}
                onClose={closeContextMenu} onTogglePinned={onTogglePinned} onToggleFavorite={onToggleFavorite}
                onOverview={setOverviewNode} onRename={onRename} onDelete={onDelete}
                onCreateFile={onCreateFile} onCreateFolder={onCreateFolder} onImportFiles={onImportFiles} />
            <NoteOverviewModal node={overviewNode} onClose={() => setOverviewNode(null)} onLoad={onLoadNoteOverview} />
        </aside>
    );
};

function getEditableName(node: FileNode): string {
    if (node.isDirectory) return node.name;
    return getEditableEntryName(node.name);
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
    return nodes.flatMap((node) => node.isDirectory ? flattenFiles(node.children ?? []) : [node]);
}

/** 同级置顶优先，组内沿用已有拖动顺序，取消置顶即可恢复。 */
function sortPinnedEntries(nodes: FileNode[], pinnedPaths: Set<string>): FileNode[] {
    return [...nodes]
        .sort((left, right) => Number(pinnedPaths.has(right.path)) - Number(pinnedPaths.has(left.path)))
        .map((node) => node.isDirectory ? { ...node, children: sortPinnedEntries(node.children ?? [], pinnedPaths) } : node);
}

function samePaths(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function getDragPayload(event: React.DragEvent): DragPayload | null {
    const raw = event.dataTransfer.getData('application/x-menghan-entry');
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as DragPayload;
        if (typeof parsed.path !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

function getDropIntent(event: React.DragEvent<HTMLElement>, node: FileNode): 'before' | 'inside' | 'after' {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (y < rect.height * 0.25) return 'before';
    if (y > rect.height * 0.75) return 'after';
    return node.isDirectory ? 'inside' : 'before';
}

export default Sidebar;
