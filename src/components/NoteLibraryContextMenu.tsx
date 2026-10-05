import { t, useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { Button, Group, Menu, Modal, Text, TextInput } from '@mantine/core';
import { Edit2, FileText, FolderPlus, Import, Pin, PinOff, Plus, Star, Trash2 } from 'lucide-react';
import type { FileNode } from '../electron';
import { getEditableEntryName, getSidebarDisplayName } from '../utils/sidebarDisplay';
import './NoteLibrary.css';

export interface NoteLibraryMenuTarget {
    node: FileNode;
    x: number;
    y: number;
}

interface Props {
    target: NoteLibraryMenuTarget | null;
    pinned: boolean;
    favorite: boolean;
    entryActionsDisabled: boolean;
    onRenameDialogChange: (opened: boolean) => void;
    onClose: () => void;
    onTogglePinned: (path: string) => Promise<void>;
    onToggleFavorite: (path: string) => void;
    onOverview: (node: FileNode) => void;
    onRename: (path: string, name: string) => Promise<boolean | void> | void;
    onDelete: (path: string, isDirectory: boolean) => void;
    onCreateFile: (path: string) => void;
    onCreateFolder: (path: string) => void;
    onImportFiles: (path: string) => void;
}

/** 复用笔记库操作回调，菜单和重命名弹窗都由 Mantine 管理焦点。 */
export default function NoteLibraryContextMenu(props: Props) {
  useI18n();
    const { target, onClose } = props;
    const node = target?.node;
    const [renameTarget, setRenameTarget] = useState<FileNode | null>(null);
    const [name, setName] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [renameError, setRenameError] = useState<string | null>(null);
    const { onRenameDialogChange } = props;

    useEffect(() => {
        onRenameDialogChange(Boolean(renameTarget));
        return () => onRenameDialogChange(false);
    }, [renameTarget, onRenameDialogChange]);

    useEffect(() => {
        if (!target) return;
        const closeOnScroll = () => onClose();
        window.addEventListener('resize', closeOnScroll);
        return () => {
            window.removeEventListener('resize', closeOnScroll);
        };
    }, [target, onClose]);

    const submitRename = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!renameTarget || !name.trim() || renaming) return;
        setRenaming(true);
        setRenameError(null);
        try {
            const original = renameTarget.isDirectory ? renameTarget.name : getEditableEntryName(renameTarget.name);
            if (name.trim() !== original && await props.onRename(renameTarget.path, name.trim()) === false) {
                setRenameError(t("重命名未完成，请检查名称后重试。"));
                return;
            }
            setRenameTarget(null);
        } catch (error) {
            setRenameError(error instanceof Error ? error.message : String(error));
        } finally {
            setRenaming(false);
        }
    };

    return <>
        <Menu opened={Boolean(target)} onChange={(opened) => { if (!opened) onClose(); }}
            position="bottom-start" offset={4} shadow="md" width={210} withinPortal returnFocus={false}>
            <Menu.Target>
                <span className="note-library-menu-anchor" style={{ left: target?.x ?? 0, top: target?.y ?? 0 }} aria-hidden="true" />
            </Menu.Target>
            <Menu.Dropdown className="note-library-context-menu">
                <Menu.Label className="note-library-menu-title" title={node?.name}>{node ? getSidebarDisplayName(node) : ''}</Menu.Label>
                <Menu.Item leftSection={props.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                    onClick={() => { if (node) void props.onTogglePinned(node.path).catch((error) => window.alert(t("置顶失败：{0}", { '0': String(error) }))); }}>
                    {props.pinned ? t("取消置顶") : t("置顶")}
                </Menu.Item>
                {!node?.isDirectory ? <>
                    <Menu.Item leftSection={<FileText size={15} />} onClick={() => { if (node) props.onOverview(node); }}>{t("查看概览")}</Menu.Item>
                    <Menu.Item leftSection={<Star size={15} fill={props.favorite ? 'currentColor' : 'none'} />}
                        onClick={() => { if (node) props.onToggleFavorite(node.path); }}>{props.favorite ? t("取消收藏") : t("收藏")}</Menu.Item>
                </> : <>
                    <Menu.Divider />
                    <Menu.Item disabled={props.entryActionsDisabled} leftSection={<Plus size={15} />} onClick={() => { if (node) props.onCreateFile(node.path); }}>{t("在此新建笔记")}</Menu.Item>
                    <Menu.Item disabled={props.entryActionsDisabled} leftSection={<FolderPlus size={15} />} onClick={() => { if (node) props.onCreateFolder(node.path); }}>{t("新建子文件夹")}</Menu.Item>
                    <Menu.Item disabled={props.entryActionsDisabled} leftSection={<Import size={15} />} onClick={() => { if (node) props.onImportFiles(node.path); }}>{t("导入到此文件夹")}</Menu.Item>
                </>}
                <Menu.Divider />
                <Menu.Item disabled={props.entryActionsDisabled} leftSection={<Edit2 size={15} />} onClick={() => {
                    if (!node) return;
                    setRenameTarget(node);
                    setName(node.isDirectory ? node.name : getEditableEntryName(node.name));
                    setRenameError(null);
                }}>{t("重命名")}</Menu.Item>
                <Menu.Item disabled={props.entryActionsDisabled} color="red" leftSection={<Trash2 size={15} />} onClick={() => { if (node) props.onDelete(node.path, node.isDirectory); }}>
                    {node?.isDirectory ? t("删除文件夹") : t("删除笔记")}
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
        <Modal opened={Boolean(renameTarget)} onClose={() => { if (!renaming) setRenameTarget(null); }}
            title={renameTarget?.isDirectory ? t("重命名文件夹") : t("重命名笔记")} centered size="sm" closeOnClickOutside={!renaming} closeOnEscape={!renaming}>
            <form onSubmit={(event) => void submitRename(event)}>
                <TextInput label={t("名称")} value={name} onChange={(event) => setName(event.currentTarget.value)}
                    data-autofocus onFocus={(event) => event.currentTarget.select()} error={renameError} disabled={renaming} />
                {renameTarget && !renameTarget.isDirectory ? <Text size="xs" c="dimmed" mt={8}>{t("文件扩展名会自动保留。")}</Text> : null}
                <Group justify="flex-end" mt="lg">
                    <Button variant="default" onClick={() => setRenameTarget(null)} disabled={renaming}>{t("取消")}</Button>
                    <Button type="submit" disabled={!name.trim()} loading={renaming}>{t("保存")}</Button>
                </Group>
            </form>
        </Modal>
    </>;
}
