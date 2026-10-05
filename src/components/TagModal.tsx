import { t, useI18n } from '../i18n';
import React, { useEffect, useState } from 'react';
import { FileText, Tags, X } from 'lucide-react';
import type { FileNode, TagSummary } from '../electron';

interface TagModalProps {
    isOpen: boolean;
    tags: TagSummary[];
    onClose: () => void;
    onSelectFile: (path: string) => void;
}

const TagModal: React.FC<TagModalProps> = ({ isOpen, tags, onClose, onSelectFile }) => {
  useI18n();
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [files, setFiles] = useState<FileNode[]>([]);

    useEffect(() => {
        if (!isOpen) return;
        const firstTag = tags[0]?.tag ?? null;
        setSelectedTag(firstTag);
    }, [isOpen, tags]);

    useEffect(() => {
        if (!isOpen || !selectedTag || !window.electronAPI) {
            setFiles([]);
            return;
        }

        window.electronAPI.getFilesByTag(selectedTag).then(setFiles);
    }, [isOpen, selectedTag]);

    if (!isOpen) return null;

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="tag-modal" onClick={(event) => event.stopPropagation()}>
                <header className="tag-modal-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Tags size={18} />
                        <strong>{t("标签")}</strong>
                    </div>
                    <button className="icon-button" onClick={onClose} title={t("关闭")}>
                        <X size={18} />
                    </button>
                </header>

                <div className="tag-modal-body">
                    <aside className="tag-list">
                        {tags.length === 0 ? (
                            <div className="muted-text">{t("当前库还没有标签")}</div>
                        ) : tags.map((tag) => (
                            <button
                                key={tag.tag}
                                className={`tag-list-item ${selectedTag === tag.tag ? 'active' : ''}`}
                                onClick={() => setSelectedTag(tag.tag)}
                            >
                                <span>#{tag.tag}</span>
                                <span>{tag.count}</span>
                            </button>
                        ))}
                    </aside>

                    <main className="tag-file-list">
                        {selectedTag && files.length === 0 ? (
                            <div className="muted-text">{t("没有找到笔记")}</div>
                        ) : null}
                        {files.map((file) => (
                            <button
                                key={file.path}
                                className="tag-file-item"
                                onClick={() => {
                                    onSelectFile(file.path);
                                    onClose();
                                }}
                            >
                                <FileText size={14} />
                                <span>{file.title ?? file.name.replace(/\.[^.]+$/, '')}</span>
                            </button>
                        ))}
                    </main>
                </div>
            </div>
        </div>
    );
};

export default TagModal;
