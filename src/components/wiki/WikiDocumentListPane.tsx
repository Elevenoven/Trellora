import { getAppLanguage, t, useI18n } from '../../i18n';
import { ActionIcon, Alert, Badge, Group, Loader, ScrollArea, Stack, Text, TextInput, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { AlertCircle, FileText, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MaterialsLibrarySummary } from '../../electron';
import { getMaterialsIconOption } from '../../utils/materialsIcons';
import type { WikiLibraryDocument } from '../../wiki/wikiElectronDataSource';

interface WikiDocumentListPaneProps {
  library: MaterialsLibrarySummary;
  documents: WikiLibraryDocument[];
  selectedDocumentId: string | null;
  loading: boolean;
  loadingDocumentId: string | null;
  error: string | null;
  onSelectDocument: (document: WikiLibraryDocument) => void;
  onRefresh: () => void;
}

export default function WikiDocumentListPane({
  library,
  documents,
  selectedDocumentId,
  loading,
  loadingDocumentId,
  error,
  onSelectDocument,
  onRefresh,
}: WikiDocumentListPaneProps) {
  useI18n();
  const [query, setQuery] = useState('');
  const icon = getMaterialsIconOption(library.icon);
  const visibleDocuments = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return normalized
      ? documents.filter((document) => document.name.toLocaleLowerCase('zh-CN').includes(normalized))
      : documents;
  }, [documents, query]);

  return (
    <aside className="wiki-document-list-pane" aria-label={t("{0}文档列表", { '0': library.alias })}>
      <header className="wiki-document-list-header">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="sm" wrap="nowrap" miw={0}>
            <ThemeIcon size={38} radius="md" variant="light" color={icon.color}><icon.Icon size={19} /></ThemeIcon>
            <Stack gap={1} miw={0}>
              <Text size="xs" c="dimmed" fw={700}>{t("文档列表")}</Text>
              <Text size="sm" fw={700} truncate>{library.alias}</Text>
              <Text size="xs" c="dimmed">{documents.length} {t("个文档")}</Text>
            </Stack>
          </Group>
          <Tooltip label={t("刷新文档与索引状态")} withArrow>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("刷新文档列表")} onClick={onRefresh} loading={loading}>
              <RefreshCw size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <TextInput
          className="wiki-document-list-search"
          size="xs"
          mt="sm"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          leftSection={<Search size={13} />}
          placeholder={t("搜索当前知识库文档")}
          aria-label={t("搜索当前知识库文档")}
        />
      </header>

      {error ? <Alert className="wiki-document-list-alert" color="red" variant="light" icon={<AlertCircle size={14} />}>{error}</Alert> : null}

      <ScrollArea className="wiki-document-list-scroll" type="auto">
        {loading && documents.length === 0 ? (
          <Group justify="center" py="xl"><Loader size="sm" color="teal" /></Group>
        ) : visibleDocuments.length === 0 ? (
          <Stack align="center" gap={5} px="md" py={42}>
            <FileText size={22} color="var(--wiki-muted)" />
            <Text size="sm" fw={650}>{documents.length === 0 ? t("当前知识库没有文档") : t("没有匹配的文档")}</Text>
            <Text size="xs" c="dimmed" ta="center">{documents.length === 0 ? t("请先在资料库中上传并处理文档。") : t("调整搜索词后再试。")}</Text>
          </Stack>
        ) : (
          <Stack gap={3} p={8}>
            {visibleDocuments.map((document) => {
              const ready = document.outlineState === 'ready';
              const opening = loadingDocumentId === document.id;
              return (
                <Tooltip key={document.id} label={document.outlineHint} disabled={ready} position="right" withArrow>
                  <div>
                    <UnstyledButton
                      className="wiki-document-list-item"
                      data-state={document.outlineState}
                      data-active={document.id === selectedDocumentId || undefined}
                      disabled={!ready || opening}
                      onClick={() => onSelectDocument(document)}
                    >
                      <ThemeIcon className="wiki-document-list-icon" size={30} radius={7} variant="light" color={ready ? 'teal' : 'gray'}>
                        {opening ? <Loader size={13} color="teal" /> : <FileText size={15} />}
                      </ThemeIcon>
                      <span className="wiki-document-list-copy">
                        <Text size="sm" fw={620} truncate title={document.relativePath}>{document.name}</Text>
                        <Group gap={5} wrap="nowrap">
                          <Text size="xs" c="dimmed" truncate>{formatBytes(document.sizeBytes)} · {formatDate(document.addedAt)}</Text>
                          <Badge size="xs" variant="light" color={statusColor(document.outlineState)}>{document.outlineLabel}</Badge>
                        </Group>
                      </span>
                    </UnstyledButton>
                  </div>
                </Tooltip>
              );
            })}
          </Stack>
        )}
      </ScrollArea>
      <Text className="wiki-document-list-footnote" size="xs" c="dimmed">{t("点击已索引文档后，这里将切换为文档目录。")}</Text>
    </aside>
  );
}

function statusColor(state: WikiLibraryDocument['outlineState']): string {
  if (state === 'ready') return 'teal';
  if (state === 'processing') return 'blue';
  if (state === 'failed') return 'red';
  return 'gray';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("时间未知");
  return new Intl.DateTimeFormat(getAppLanguage(), { month: '2-digit', day: '2-digit' }).format(date);
}
