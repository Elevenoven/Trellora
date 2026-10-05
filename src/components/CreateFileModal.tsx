import { t, useI18n } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface CreateFileModalProps {
    isOpen: boolean;
    title?: string;
    label?: string;
    defaultName?: string;
    confirmText?: string;
    onClose: () => void;
    onConfirm: (fileName: string) => void;
}

const CreateFileModal: React.FC<CreateFileModalProps> = ({
    isOpen,
    title = t("新建笔记"),
    label = t("笔记名称"),
    defaultName = t("未命名"),
    confirmText = t("创建"),
    onClose,
    onConfirm,
}) => {
  useI18n();
    const [fileName, setFileName] = useState(defaultName);
    const [error, setError] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setFileName(defaultName);
            setError('');
            setTimeout(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            }, 100);
        }
    }, [defaultName, isOpen]);

    const validateFileName = (name: string): boolean => {
        if (!name.trim()) {
            setError(t("名称不能为空"));
            return false;
        }

        const invalidChars = /[<>:"/\\|?*]/;
        if (invalidChars.test(name)) {
            setError(t("名称包含非法字符"));
            return false;
        }

        setError('');
        return true;
    };

    const handleConfirm = () => {
        if (validateFileName(fileName)) {
            onConfirm(fileName.trim());
            onClose();
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Enter') {
            handleConfirm();
        } else if (event.key === 'Escape') {
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="simple-modal" onClick={(event) => event.stopPropagation()}>
                <div className="simple-modal-header">
                    <h3>{title}</h3>
                    <button onClick={onClose} className="icon-button" title={t("关闭")}>
                        <X size={20} />
                    </button>
                </div>

                <div style={{ marginBottom: 16 }}>
                    <label htmlFor="entryName" className="simple-modal-label">
                        {label}
                    </label>
                    <input
                        ref={inputRef}
                        id="entryName"
                        type="text"
                        value={fileName}
                        onChange={(event) => setFileName(event.target.value)}
                        onKeyDown={handleKeyDown}
                        className={`simple-modal-input ${error ? 'error' : ''}`}
                        placeholder={t("输入名称...")}
                    />
                    {error ? <p className="simple-modal-error">{error}</p> : null}
                </div>

                <div className="simple-modal-actions">
                    <button onClick={onClose} className="secondary-button">
                        {t("取消")}
                    </button>
                    <button onClick={handleConfirm} className="primary-button">
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CreateFileModal;
