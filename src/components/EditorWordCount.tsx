import { useMemo } from 'react';
import { useI18n } from '../i18n';
import { contentToEditorHtml } from '../utils/markdown';
import './EditorWordCount.css';

interface EditorWordCountProps {
    content: string;
    isMarkdown: boolean;
}

export default function EditorWordCount({ content, isMarkdown }: EditorWordCountProps) {
    const { language, t } = useI18n();
    const count = useMemo(() => {
        let text = content;
        if (isMarkdown) {
            // 在离屏模板中提取正文，避免计入格式标记、链接地址和元数据。
            const template = document.createElement('template');
            template.innerHTML = contentToEditorHtml(content);
            template.content.querySelectorAll('script, style').forEach(node => node.remove());
            text = template.content.textContent ?? '';
        }
        // 按 Unicode 字符计数，空格和换行不计入字数。
        return Array.from(text.replace(/\s/gu, '')).length;
    }, [content, isMarkdown]);

    return (
        <span className="editor-word-count" title={t("正文字符数（不含空格、换行和格式标记）")}>
            {t("{count} 字", { count: count.toLocaleString(language) })}
        </span>
    );
}
