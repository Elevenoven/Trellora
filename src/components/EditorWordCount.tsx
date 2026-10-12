import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { contentToEditorHtml } from '../utils/markdown';
import { scheduleAfterPaint } from '../utils/afterPaint';
import './EditorWordCount.css';

interface EditorWordCountProps {
    content: string;
    isMarkdown: boolean;
    active?: boolean;
}

export default function EditorWordCount({ content, isMarkdown, active = true }: EditorWordCountProps) {
    const { language, t } = useI18n();
    const [retry, setRetry] = useState(0);
    const [result, setResult] = useState<{ content: string; retry: number; count?: number; error?: boolean }>();
    const plainCount = useMemo(() => isMarkdown ? undefined : Array.from(content.replace(/\s/gu, '')).length, [content, isMarkdown]);
    useEffect(() => {
        if (!isMarkdown || !active || (result?.content === content && result.retry === retry)) return;
        // 精确统计保留原有正文语义，取消旧任务，并把昂贵的 HTML 转换放到正文绘制机会之后。
        return scheduleAfterPaint(() => {
            try {
                // 在离屏模板中提取正文，避免计入格式标记、链接地址和元数据。
                const template = document.createElement('template');
                template.innerHTML = contentToEditorHtml(content);
                template.content.querySelectorAll('script, style').forEach(node => node.remove());
                const text = template.content.textContent ?? '';
                setResult({ content, retry, count: Array.from(text.replace(/\s/gu, '')).length });
            } catch { setResult({ content, retry, error: true }); }
        });
    }, [content, isMarkdown, active, retry, result]);
    const current = result?.content === content && result.retry === retry ? result : undefined;
    const count = isMarkdown ? current?.count : plainCount;
    const state = count !== undefined ? 'ready' : current?.error ? 'error' : 'loading';

    return (
        <span className="editor-word-count" data-state={state} aria-busy={state === 'loading'} title={t("正文字符数（不含空格、换行和格式标记）")}>
            {count !== undefined ? t("{count} 字", { count: count.toLocaleString(language) }) : current?.error
                ? <button type="button" onClick={() => setRetry(value => value + 1)}>{t('重试字数统计')}</button>
                : t('正在统计…')}
        </span>
    );
}
