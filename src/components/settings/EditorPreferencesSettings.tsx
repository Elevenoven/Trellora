import { useState, type ReactNode } from 'react';
import { NumberInput, Select, Switch, Text, Paper } from '@mantine/core';
import { t, useI18n } from '../../i18n';
import { EDITOR_ZOOM_MIN, EDITOR_ZOOM_MAX, EDITOR_ZOOM_STEP, type EditorPreferences } from '../../../shared/editorPreferences';

function Field({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <Paper withBorder radius="md" p="md" className="settings-field-card"><div className="settings-field-row"><div className="settings-field-copy"><Text fw={600} size="sm">{t(title)}</Text>{description && <Text size="xs" c="dimmed" mt={4}>{t(description)}</Text>}</div><div className="settings-field-control">{children}</div></div></Paper>;
}

function NumericField({ title, value, min, max, step = 1, onSave }: { title: string; value: number; min: number; max: number; step?: number; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState<number | string | null>(null);
  return <Field title={title} description={`${min}–${max}${step >= 1 ? ' px' : ''}`}><NumberInput aria-label={t(title)} value={draft ?? value} min={min} max={max} step={step} decimalScale={step < 1 ? 1 : 0}
    onChange={setDraft} onBlur={() => { if (typeof draft === 'number' && Number.isFinite(draft)) onSave(draft); setDraft(null); }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></Field>;
}

/** Editor preferences use the existing settings save queue and rollback feedback. */
export default function EditorPreferencesSettings({ preferences: p, onSave }: { preferences: EditorPreferences; onSave: (patch: Partial<EditorPreferences>) => Promise<void> }) {
  useI18n();
  const save = (patch: Partial<EditorPreferences>) => { void onSave(patch).catch(() => undefined); };
  const toggle = (key: keyof EditorPreferences, title: string, description: string) => <Field title={title} description={description}><Switch aria-label={t(title)} checked={Boolean(p[key])} onChange={event => save({ [key]: event.currentTarget.checked })} /></Field>;
  return <>
    <Text fw={650} size="sm" mt="lg">{t('正文排版')}</Text>
    <NumericField title="正文字号" value={p.editorFontSizePx} min={12} max={24} onSave={editorFontSizePx => save({ editorFontSizePx })} />
    <NumericField title="行距" value={p.editorLineHeight} min={1.2} max={2.4} step={0.1} onSave={editorLineHeight => save({ editorLineHeight })} />
    <NumericField title="段落间距" value={p.editorParagraphSpacingPx} min={0} max={32} onSave={editorParagraphSpacingPx => save({ editorParagraphSpacingPx })} />
    <Field title="正文宽度"><Select aria-label={t('正文宽度')} value={p.editorContentWidth} data={['narrow', 'standard', 'wide', 'full'].map((value, i) => ({ value, label: t(['窄版', '标准', '宽版', '铺满窗口'][i]) }))} onChange={value => value && save({ editorContentWidth: value as EditorPreferences['editorContentWidth'] })} /></Field>
    <Field title="默认缩放比例" description="工具栏缩放仅影响当前会话；重启后使用默认比例。"><Select aria-label={t('默认缩放比例')} value={String(p.defaultEditorZoom)} data={Array.from({ length: Math.round((EDITOR_ZOOM_MAX - EDITOR_ZOOM_MIN) / EDITOR_ZOOM_STEP) + 1 }, (_, i) => { const n = Number((EDITOR_ZOOM_MIN + i * EDITOR_ZOOM_STEP).toFixed(2)); return { value: String(n), label: `${Math.round(n * 100)}%` }; })} onChange={value => value && save({ defaultEditorZoom: Number(value) })} /></Field>
    <Text fw={650} size="sm" mt="lg">{t('输入与选区')}</Text>
    <Field title="粘贴方式" description="编辑模式生效；Ctrl+Shift+V 始终粘贴纯文本。"><Select aria-label={t('粘贴方式')} value={p.editorPasteMode} data={[{ value: 'preserve-format', label: t('保留格式') }, { value: 'plain-text', label: t('纯文本') }]} onChange={value => value && save({ editorPasteMode: value as EditorPreferences['editorPasteMode'] })} /></Field>
    {toggle('editorMarkdownAutoConvert', 'Markdown 自动转换', '编辑模式输入 Markdown 标记时自动转换格式。')}
    {toggle('editorSelectionToolbarEnabled', '选区浮动工具栏', '编辑模式选中文字后显示格式与 AI 操作。')}
    <Text fw={650} size="sm" mt="lg">{t('写作模式')}</Text>
    {toggle('editorFocusModeEnabled', '专注模式', '隐藏笔记侧栏，保留正文与退出入口。')}
    {toggle('editorTypewriterModeEnabled', '打字机模式', '编辑时让光标行保持在正文区域中间；预览时暂停。')}
  </>;
}
