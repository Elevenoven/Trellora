import { getAppLanguage, t, useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text, Title } from '@mantine/core';
import { AlertCircle, FileText, ListChecks, Tags } from 'lucide-react';
import type { FileNode, NoteAnalysis, NoteMeta } from '../electron';
import { getSidebarDisplayName } from '../utils/sidebarDisplay';
import './NoteLibrary.css';

export interface NoteOverviewData {
    meta: NoteMeta;
    analysis: NoteAnalysis | null;
}

interface Props {
    node: FileNode | null;
    onClose: () => void;
    onLoad: (path: string) => Promise<NoteOverviewData>;
}

/** 读取右键目标的现有分析；关闭或切换目标后丢弃迟到响应。 */
export default function NoteOverviewModal({ node, onClose, onLoad }: Props) {
  useI18n();
    const [data, setData] = useState<NoteOverviewData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const loadRef = useRef(onLoad);
    useEffect(() => { loadRef.current = onLoad; }, [onLoad]);
    const path = node?.path;

    useEffect(() => {
        setData(null);
        setError(null);
        if (!path) { setLoading(false); return; }
        let active = true;
        setLoading(true);
        void loadRef.current(path).then((result) => {
            if (active) setData(result);
        }).catch((failure) => {
            if (active) setError(failure instanceof Error ? failure.message : String(failure));
        }).finally(() => {
            if (active) setLoading(false);
        });
        return () => { active = false; };
    }, [path, attempt]);

    const analysis = data?.analysis;
    const tags = data?.meta.tags ?? [];
    return <Modal opened={Boolean(node)} onClose={onClose} centered size={660} padding={0}
        title={<Group gap={8}><FileText size={16} /><Text size="sm" fw={600}>{t("笔记概览")}</Text></Group>}
        classNames={{ content: 'note-overview-modal', header: 'note-overview-modal-header', body: 'note-overview-modal-body' }}>
        <div className="note-overview-heading">
            <Title order={2} className="note-overview-title">{data?.meta.title || (node ? getSidebarDisplayName(node) : '')}</Title>
            <section className="note-overview-tags" aria-label={t("笔记标签")}>
                <div className="note-overview-section-label"><Tags size={14} /><span>{t("标签")}</span></div>
                {tags.length ? <Group gap={6} className="note-overview-tag-list">{tags.map((tag) => <Badge key={tag} variant="light" color="gray" radius="sm" className="note-overview-tag">{tag}</Badge>)}</Group>
                    : <Text size="xs" c="dimmed">{loading ? t("正在读取标签…") : t("暂无标签")}</Text>}
            </section>
        </div>
        {loading ? <Group justify="center" gap={10} py={40}><Loader size="sm" color="gray" /><Text size="sm" c="dimmed">{t("正在读取笔记概览…")}</Text></Group>
            : error ? <Stack gap="sm" className="note-overview-sections"><Alert color="red" icon={<AlertCircle size={16} />}>{error}</Alert><Button variant="default" size="xs" onClick={() => setAttempt((value) => value + 1)}>{t("重新加载")}</Button></Stack>
                : <div className="note-overview-sections">
                    {analysis?.isStale ? <Alert color="yellow" icon={<AlertCircle size={16} />} className="note-overview-stale">{t("笔记内容已更新，下面展示的是上次分析结果。可在右侧“笔记信息”中更新概览。")}</Alert> : null}
                    <section aria-label={t("概览")}>
                        <div className="note-overview-section-label"><FileText size={15} /><span>{t("概览")}</span></div>
                        <Text size="sm" className="note-overview-description">{analysis?.summary || (data?.meta.kind === 'text' ? t("该文件暂无概览。") : t("暂无概览。在右侧“笔记信息”中生成概览后，即可在这里查看。"))}</Text>
                    </section>
                    <section className="note-overview-points-section" aria-label={t("要点")}>
                        <div className="note-overview-section-label"><ListChecks size={15} /><span>{t("要点")}</span>{analysis?.keyPoints.length ? <Text size="xs" c="dimmed" ml="auto">{analysis.keyPoints.length} {t("条")}</Text> : null}</div>
                        {analysis?.keyPoints.length ? <ul className="note-overview-points">{analysis.keyPoints.map((point, index) => <li key={`${index}-${point}`}><span className="note-overview-point-marker" aria-hidden="true" /><Text size="sm">{point}</Text></li>)}</ul>
                            : <Text size="sm" c="dimmed">{t("暂无要点")}</Text>}
                    </section>
                </div>}
        <Group justify="space-between" className="note-overview-footer">
            <Text size="xs" c="dimmed">{analysis?.generatedAt ? t("分析于 {0}", { '0': new Date(analysis.generatedAt).toLocaleString(getAppLanguage(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : t("笔记信息")}</Text>
            <Button variant="default" size="xs" onClick={onClose}>{t("关闭")}</Button>
        </Group>
    </Modal>;
}
