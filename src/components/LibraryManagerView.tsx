import { getAppLanguage, t, useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Group, Menu, Modal, Pagination, Paper, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Ellipsis, FolderPlus, Info, Library, Search, Trash2 } from 'lucide-react';
import type { LibrarySummary } from '../electron';
import './LibraryManagerView.css';

const LIBRARY_PAGE_SIZE = 10;
const paginationControlLabels = { first: '第一页', previous: '上一页', next: '下一页', last: '最后一页' };

interface LibraryManagerViewProps {
  libraries: LibrarySummary[];
  activeLibraryPath: string | null;
  workspacePath: string | null;
  workspaceError: string | null;
  onAddLibrary: () => void;
  onOpenLibrary: (libraryPath: string) => Promise<void>;
  onRemoveLibrary: (libraryPath: string) => Promise<void>;
  onUpgradeToMaterials: (libraryPath: string) => void;
  onReturnToNotes: () => void;
}

/** 展示注册库的真实状态；库切换和移除仍由应用的保存协调器执行。 */
export default function LibraryManagerView({
  libraries, activeLibraryPath, workspacePath, workspaceError,
  onAddLibrary, onOpenLibrary, onRemoveLibrary, onUpgradeToMaterials, onReturnToNotes,
}: LibraryManagerViewProps) {
  useI18n();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const search = query.trim().toLocaleLowerCase();
  const visibleLibraries = libraries.filter((library) => `${library.alias} ${library.path}`.toLocaleLowerCase().includes(search));
  const pageCount = Math.max(1, Math.ceil(visibleLibraries.length / LIBRARY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * LIBRARY_PAGE_SIZE;
  const pageLibraries = visibleLibraries.slice(pageStart, pageStart + LIBRARY_PAGE_SIZE);
  const removingLibrary = libraries.find((library) => library.path === removingPath);

  // 库被移除后收敛到有效页，避免空页或后续新增时跳回旧页码。
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0 });
  }, [currentPage, search]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setPage(1);
    setCopiedPath(null);
  };

  const requestRemoval = (libraryPath: string) => {
    setRemovalError(null);
    setRemovingPath(libraryPath);
  };

  const confirmRemoval = async () => {
    if (!removingPath || isRemoving) return;
    setIsRemoving(true);
    setRemovalError(null);
    try {
      await onRemoveLibrary(removingPath);
      setRemovingPath(null);
    } catch (error) {
      setRemovalError(error instanceof Error ? error.message : t("移除笔记库失败，请重试。"));
    } finally {
      setIsRemoving(false);
    }
  };

  const copyLocation = async (libraryPath: string) => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(libraryPath);
      setCopiedPath(libraryPath);
    } catch {
      setCopyError(t("复制失败，请从列表中选择并复制文件位置。"));
    }
  };

  return (
    <div className="library-manager-view">
      <header className="library-manager-toolbar">
        <Text size="sm" c="dimmed">{t("笔记库")}</Text>
        <Button variant="subtle" color="gray" size="xs" leftSection={<ArrowLeft size={14} />} disabled={!activeLibraryPath} onClick={onReturnToNotes}>{t("返回笔记")}</Button>
      </header>
      <div className="library-manager-content">
        <header className="library-manager-heading">
          <div><Title order={1}>{t("你的笔记库")}</Title><Text size="sm" c="dimmed" mt={6}>{t("打开一个笔记库，继续阅读与整理。")}</Text></div>
          <Button className="library-manager-create" variant="light" color="teal" leftSection={<FolderPlus size={15} />} onClick={onAddLibrary}>{t("新建笔记库")}</Button>
        </header>
        {workspaceError || copyError ? <Alert className="library-manager-error" icon={<AlertCircle size={16} />} color="red" variant="light">{workspaceError ?? copyError}</Alert> : null}
        <Group className="library-manager-filter" justify="space-between" gap="sm">
          <Text size="xs" c="dimmed">{search ? `${visibleLibraries.length} / ${libraries.length}` : libraries.length} {t("个笔记库")}</Text>
          <TextInput className="library-manager-search" size="xs" leftSection={<Search size={14} />} placeholder={t("按名称或位置搜索")} aria-label={t("搜索笔记库")} value={query} onChange={(event) => changeQuery(event.currentTarget.value)} />
        </Group>
        {libraries.length === 0 ? (
          <Paper className="library-manager-empty" withBorder radius="md">
            <ThemeIcon size={44} radius="md" variant="light" color="teal"><Library size={23} /></ThemeIcon>
            <Title order={3}>{t("还没有笔记库")}</Title>
            <Text size="sm" c="dimmed">{t("创建一个笔记库，开始整理你的笔记。")}</Text>
            {workspacePath ? <Text size="xs" c="dimmed" className="library-manager-empty-path">{t("默认存放位置：")}{workspacePath}</Text> : null}
            <Button variant="light" color="teal" leftSection={<FolderPlus size={15} />} onClick={onAddLibrary}>{t("新建笔记库")}</Button>
          </Paper>
        ) : (
          <>
            <Paper className="library-manager-scroll" ref={viewportRef} tabIndex={0} role="region" aria-label={t("笔记库列表")}>
              <Paper className="library-manager-list" withBorder radius="md">
                {pageLibraries.map((library) => {
                  const isCurrent = library.path === activeLibraryPath;
                  return (
                    <section className={`library-manager-row ${isCurrent ? 'is-current' : ''}`} key={library.path} aria-label={library.alias}>
                      <div className="library-manager-icon"><Library size={18} strokeWidth={1.6} /></div>
                      <div className="library-manager-details">
                        <Group gap={8} wrap="nowrap" className="library-manager-name">
                          <Text fw={650} size="sm" truncate title={library.alias}>{library.alias}</Text>
                          {isCurrent ? <Badge size="xs" variant="light" color="teal">{t("当前")}</Badge> : null}
                        </Group>
                        <Text className="library-manager-path" component="span" size="xs" c="dimmed" title={library.path}>{library.path}</Text>
                        <Group gap={14} className="library-manager-metadata">
                          <Text size="xs" c="dimmed">{library.noteCount} {t("篇笔记")}</Text>
                          <Text size="xs" c="dimmed">{t("最近打开")} {formatDate(library.lastOpenedAt)}</Text>
                          <Text size="xs" c={library.exists ? 'dimmed' : 'orange'}>{library.exists ? t("可用") : t("路径不可用")}</Text>
                          {copiedPath === library.path ? <Text size="xs" c="teal" role="status">{t("位置已复制")}</Text> : null}
                        </Group>
                      </div>
                      <Group className="library-manager-actions" gap={8} wrap="nowrap">
                        <Button variant="default" size="xs" disabled={!library.exists || isRemoving} onClick={() => void onOpenLibrary(library.path)}>{isCurrent ? t("进入笔记") : t("打开")}</Button>
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={t("{0} 操作", { '0': library.alias })} disabled={isRemoving}><Ellipsis size={17} /></ActionIcon></Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item leftSection={<ArrowRight size={15} />} disabled={!library.exists} onClick={() => void onOpenLibrary(library.path)}>{t("打开笔记")}</Menu.Item>
                            <Menu.Item leftSection={copiedPath === library.path ? <Check size={15} /> : <Copy size={15} />} onClick={() => void copyLocation(library.path)}>{t("复制文件位置")}</Menu.Item>
                            <Menu.Item leftSection={<ArrowUpRight size={15} />} disabled={!library.exists} onClick={() => onUpgradeToMaterials(library.path)}>{t("升级为资料库")}</Menu.Item>
                            <Menu.Divider />
                            <Menu.Item color="red" leftSection={<Trash2 size={15} />} onClick={() => requestRemoval(library.path)}>{t("移除注册")}</Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </section>
                  );
                })}
                {visibleLibraries.length === 0 ? <Stack className="library-manager-no-results" align="center" gap="sm"><Text size="sm" c="dimmed">{t("没有找到匹配的笔记库")}</Text><Button variant="subtle" color="gray" size="xs" onClick={() => changeQuery('')}>{t("清空搜索")}</Button></Stack> : null}
              </Paper>
            </Paper>
            <Group className="library-manager-pagination" component="nav" aria-label={t("笔记库分页")} justify="space-between" gap="sm">
              <Text size="xs" c="dimmed">{visibleLibraries.length > 0 ? t("{0}–{1} / {2} 个", { '0': pageStart + 1, '1': pageStart + pageLibraries.length, '2': visibleLibraries.length }) : t("0 个匹配笔记库")} {t("· 每页")} {LIBRARY_PAGE_SIZE} {t("个")}</Text>
              {visibleLibraries.length > 0 ? <Pagination size="sm" color="teal" total={pageCount} value={currentPage} onChange={setPage} withEdges getItemProps={(pageNumber) => ({ 'aria-label': t("第 {0} 页", { '0': pageNumber }) })} getControlProps={(control) => ({ 'aria-label': paginationControlLabels[control] })} /> : null}
            </Group>
          </>
        )}
        {libraries.length > 0 ? <Group className="library-manager-hint" gap={7} wrap="nowrap"><Info size={14} /><Text size="xs">{t("移除注册后，磁盘上的笔记文件会保留。")}</Text></Group> : null}
      </div>
      <Modal opened={Boolean(removingPath)} onClose={() => { if (!isRemoving) setRemovingPath(null); }} title={t("移除笔记库注册")} centered closeOnEscape={!isRemoving} closeOnClickOutside={!isRemoving} withCloseButton={!isRemoving}>
        <Stack gap="md">
          <Text size="sm">{t("只移除 Trellora 中的注册项，磁盘上的文件会保留。")}</Text>
          <Text fw={650}>{removingLibrary?.alias}</Text>
          {removalError ? <Alert icon={<AlertCircle size={16} />} color="red" variant="light">{removalError}</Alert> : null}
          <Group justify="flex-end">
            <Button variant="default" disabled={isRemoving} onClick={() => setRemovingPath(null)}>{t("取消")}</Button>
            <Button color="red" leftSection={<Trash2 size={15} />} loading={isRemoving} onClick={() => void confirmRemoval()}>{t("移除注册")}</Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(getAppLanguage(), { month: 'numeric', day: 'numeric' }).format(date);
}
