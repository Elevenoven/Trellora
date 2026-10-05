import { t, useI18n } from '../i18n';
import React from 'react';
import { Editor } from '@tiptap/react';
import { Box, Group, Select } from '@mantine/core';
import {
    Bold,
    Italic,
    Strikethrough,
    Code,
    Link,
    Heading1,
    Heading2,
    Heading3,
    List,
    ListTodo,
    ListOrdered,
    Quote,
    CodeSquare,
    Check,
    Table2,
    ArrowUpFromLine,
    ArrowDownFromLine,
    ArrowLeftFromLine,
    ArrowRightFromLine,
    TableRowsSplit,
    TableColumnsSplit,
    Undo,
    Redo,
    RemoveFormatting,
    Trash2
} from 'lucide-react';
import { CODE_LANGUAGE_ICON_MARKS, CODE_LANGUAGE_OPTIONS, normalizeCodeLanguage, toCodeBlockLanguage } from '../utils/codeLanguages';

const renderCodeLanguageIcon = (language: string) => (
    <span className={`code-language-option-icon is-${language}`} aria-hidden="true">
        {CODE_LANGUAGE_ICON_MARKS[language] ?? 'CODE'}
    </span>
);

interface MenuBarProps {
    editor: Editor | null;
    onEditLink: () => void;
}

const MenuBar: React.FC<MenuBarProps> = ({ editor, onEditLink }) => {
    useI18n();
    if (!editor) {
        return null;
    }

    const buttonStyle = (isActive: boolean): React.CSSProperties => ({
        padding: '6px 8px',
        border: 'none',
        background: isActive ? 'var(--surface-selected)' : 'transparent',
        color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
        cursor: 'pointer',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.2s',
    });

    const smallButtonStyle = (isActive = false, disabled = false): React.CSSProperties => ({
        ...buttonStyle(isActive),
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
    });

    const handleToolbarMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
    };

    const toggleTaskListAtSelection = () => {
        editor.chain().focus().toggleTaskList().run();
    };

    const currentCodeLanguage = editor.isActive('codeBlock')
        ? normalizeCodeLanguage(editor.getAttributes('codeBlock').language as string | undefined)
        : 'plaintext';

    const setCodeBlockLanguage = (language: string) => {
        const normalizedLanguage = normalizeCodeLanguage(language);
        const editorLanguage = toCodeBlockLanguage(normalizedLanguage);
        if (editor.isActive('codeBlock')) {
            editor.chain().focus().updateAttributes('codeBlock', { language: editorLanguage ?? '' }).run();
            return;
        }

        editor.chain().focus().setCodeBlock({ language: editorLanguage ?? '' }).run();
    };

    const isInTable = editor.isActive('table');
    const canEditLink = editor.isEditable && !editor.isActive('codeBlock') && !editor.isActive('formulaBlock')
        && editor.can().setLink({ href: 'https://example.com' });

    return (
        <div
            style={{
                display: 'flex',
                gap: 4,
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-secondary)',
                flexWrap: 'wrap',
                flexShrink: 0,
                position: 'relative',
                zIndex: 10,
            }}
        >
            {/* Text Formatting */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleBold().run()}
                style={buttonStyle(editor.isActive('bold'))}
                title="Bold (Ctrl+B)"
            >
                <Bold size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                style={buttonStyle(editor.isActive('italic'))}
                title="Italic (Ctrl+I)"
            >
                <Italic size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleStrike().run()}
                style={buttonStyle(editor.isActive('strike'))}
                title="Strikethrough"
            >
                <Strikethrough size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleCode().run()}
                style={buttonStyle(editor.isActive('code'))}
                title="Inline Code"
            >
                <Code size={18} />
            </button>
            <button
                type="button"
                aria-label={t("链接")}
                aria-pressed={editor.isActive('link')}
                onMouseDown={handleToolbarMouseDown}
                onClick={onEditLink}
                disabled={!canEditLink}
                style={smallButtonStyle(editor.isActive('link'), !canEditLink)}
                title={t("添加或编辑链接")}
            >
                <Link size={18} />
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

            {/* Headings */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                style={buttonStyle(editor.isActive('heading', { level: 1 }))}
                title="Heading 1"
            >
                <Heading1 size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                style={buttonStyle(editor.isActive('heading', { level: 2 }))}
                title="Heading 2"
            >
                <Heading2 size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                style={buttonStyle(editor.isActive('heading', { level: 3 }))}
                title="Heading 3"
            >
                <Heading3 size={18} />
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

            {/* Lists */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                style={buttonStyle(editor.isActive('bulletList'))}
                title="Bullet List"
            >
                <List size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={toggleTaskListAtSelection}
                style={buttonStyle(editor.isActive('taskList'))}
                title="Task List"
            >
                <ListTodo size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                style={buttonStyle(editor.isActive('orderedList'))}
                title="Numbered List"
            >
                <ListOrdered size={18} />
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

            {/* Blocks */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                style={buttonStyle(editor.isActive('blockquote'))}
                title="Quote"
            >
                <Quote size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                style={buttonStyle(editor.isActive('codeBlock'))}
                title="Code Block"
            >
                <CodeSquare size={18} />
            </button>
            <Select
                className="toolbar-code-language-select"
                classNames={{ dropdown: 'toolbar-code-language-dropdown' }}
                value={currentCodeLanguage}
                data={[
                    ...(!CODE_LANGUAGE_OPTIONS.some(language => language.value === currentCodeLanguage)
                        ? [{ value: currentCodeLanguage, label: currentCodeLanguage }]
                        : []),
                    ...CODE_LANGUAGE_OPTIONS.map(language => ({ ...language, label: t(language.label) })),
                ]}
                onChange={language => {
                    if (language) setCodeBlockLanguage(language);
                }}
                allowDeselect={false}
                size="xs"
                w={148}
                leftSection={renderCodeLanguageIcon(currentCodeLanguage)}
                leftSectionWidth={30}
                leftSectionPointerEvents="none"
                renderOption={({ option, checked }) => (
                    <Group gap={6} wrap="nowrap" w="100%">
                        {renderCodeLanguageIcon(option.value)}
                        <Box component="span" style={{ flex: 1 }}>{option.label}</Box>
                        {checked && <Check size={14} aria-hidden="true" />}
                    </Group>
                )}
                comboboxProps={{ width: 180, position: 'bottom-start' }}
                maxDropdownHeight={300}
                styles={{
                    input: {
                        height: 30,
                        minHeight: 30,
                        borderColor: 'var(--border-color)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-secondary)',
                        borderRadius: 4,
                        fontSize: 12,
                        cursor: 'pointer',
                    },
                    option: { minHeight: 30, padding: '4px 6px', fontSize: 12 },
                }}
                title={t("代码块语言")}
                aria-label={t("代码块语言")}
            />

            {/* Divider */}
            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

            {/* Tables */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
                style={buttonStyle(false)}
                title={t("插入表格")}
            >
                <Table2 size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().addRowBefore().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("在上方插入行")}
            >
                <ArrowUpFromLine size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().addRowAfter().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("在下方插入行")}
            >
                <ArrowDownFromLine size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().deleteRow().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("删除当前行")}
            >
                <TableRowsSplit size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().addColumnBefore().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("在左侧插入列")}
            >
                <ArrowLeftFromLine size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("在右侧插入列")}
            >
                <ArrowRightFromLine size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().deleteColumn().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("删除当前列")}
            >
                <TableColumnsSplit size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().deleteTable().run()}
                disabled={!isInTable}
                style={smallButtonStyle(false, !isInTable)}
                title={t("删除表格")}
            >
                <Trash2 size={18} />
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

            {/* Undo/Redo */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!editor.can().undo()}
                style={{
                    ...buttonStyle(false),
                    opacity: editor.can().undo() ? 1 : 0.3,
                    cursor: editor.can().undo() ? 'pointer' : 'not-allowed',
                }}
                title="Undo (Ctrl+Z)"
            >
                <Undo size={18} />
            </button>

            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!editor.can().redo()}
                style={{
                    ...buttonStyle(false),
                    opacity: editor.can().redo() ? 1 : 0.3,
                    cursor: editor.can().redo() ? 'pointer' : 'not-allowed',
                }}
                title="Redo (Ctrl+Y)"
            >
                <Redo size={18} />
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

            {/* Clear Formatting */}
            <button
                onMouseDown={handleToolbarMouseDown}
                onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
                style={buttonStyle(false)}
                title="Clear Formatting"
            >
                <RemoveFormatting size={18} />
            </button>
        </div>
    );
};

export default MenuBar;
