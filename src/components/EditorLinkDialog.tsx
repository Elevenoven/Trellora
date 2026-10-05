import { t, useI18n } from '../i18n';
import { useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { getMarkRange, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export interface EditorLinkRequest {
    range: { from: number; to: number };
    doc: ProseMirrorNode;
    currentPath: string;
}

interface EditorLinkDialogProps {
    editor: Editor;
    request: EditorLinkRequest;
    onClose: () => void;
}

function normalizeLinkHref(input: string): string | null {
    const value = input.trim();
    if (!value) return '';
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
    try {
        const url = new URL(candidate);
        return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? candidate : null;
    } catch {
        return null;
    }
}

export default function EditorLinkDialog({ editor, request, onClose }: EditorLinkDialogProps) {
  useI18n();
    // 光标位于已有链接时编辑完整链接；有选区时严格保留用户选择的范围。
    const [target] = useState(() => {
        const position = request.doc.resolve(request.range.from);
        const mark = (position.nodeAfter?.marks ?? position.nodeBefore?.marks ?? [])
            .find(item => item.type.name === 'link');
        const range = request.range.from === request.range.to && mark
            ? getMarkRange(position, mark.type, mark.attrs) ?? request.range
            : request.range;
        return { range, href: typeof mark?.attrs.href === 'string' ? mark.attrs.href : '' };
    });
    const [href, setHref] = useState(target.href || 'https://');
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        onClose();
        if (!editor.isDestroyed) editor.commands.focus();
    };

    // 弹窗期间原文变更后拒绝写回，防止保存的选区指向别处。
    const apply = (input: string) => {
        if (editor.isDestroyed || !editor.isEditable || !editor.state.doc.eq(request.doc)) {
            setError(t("原文已变化，请关闭弹窗后重新选择文字。"));
            return;
        }
        const value = normalizeLinkHref(input);
        if (value === null) {
            setError(t("请输入有效的 http、https、mailto 或 tel 链接。"));
            return;
        }
        const isInsertion = target.range.from === target.range.to;
        const parentAllowsLink = !isInsertion
            || request.doc.resolve(target.range.from).parent.type.allowsMarkType(editor.schema.marks.link);
        if (value && (!parentAllowsLink
            || !editor.can().chain().setTextSelection(target.range).setLink({ href: value }).run())) {
            setError(t("当前位置不能添加链接，请选择普通文字后重试。"));
            return;
        }
        const chain = editor.chain().focus().setTextSelection(target.range);
        const applied = !value ? chain.unsetLink().run()
            : isInsertion
                ? chain.insertContent({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: value } }] }).run()
                : chain.setLink({ href: value }).setMark('link', { wikiLink: null, wikiAlias: null }).run();
        if (!applied) {
            setError(t("当前位置不能添加链接，请选择普通文字后重试。"));
            return;
        }
        close();
    };

    return (
        <Modal opened onClose={close} title={target.href ? t("编辑链接") : t("添加链接")} centered size="sm" returnFocus={false}>
            <form onSubmit={event => { event.preventDefault(); apply(href); }}>
                <Stack gap="sm">
                    <TextInput
                        data-autofocus
                        label={t("链接地址")}
                        aria-label={t("链接地址")}
                        placeholder="https://example.com"
                        size="sm"
                        value={href}
                        onChange={event => { setHref(event.currentTarget.value); setError(null); }}
                        onFocus={event => event.currentTarget.select()}
                        error={error}
                        description={t("支持网页、邮箱和电话链接，留空可移除链接。")}
                    />
                    <Group justify="space-between" gap="xs">
                        <Button type="button" variant="subtle" color="red" size="xs" disabled={!target.href} onClick={() => apply('')}>{t("移除链接")}</Button>
                        <Group gap="xs">
                            <Button type="button" variant="default" size="xs" onClick={close}>{t("取消")}</Button>
                            <Button type="submit" size="xs">{t("应用")}</Button>
                        </Group>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
