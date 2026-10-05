import { getAppLanguage, t, useI18n } from '../i18n';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { AlertCircle, ArrowRight, ArrowUpRight, BookOpen, Check, Ellipsis, FileText, FolderPlus, Gauge, Library, Sparkles, Trash2 } from 'lucide-react';
import type { LibrarySummary } from '../electron';

interface HomeViewProps {
  libraries: LibrarySummary[];
  workspacePath: string | null;
  lastOpenedNote: string | null;
  workspaceError: string | null;
  onAddLibrary: () => void;
  onOpenLibrary: (libraryPath: string) => Promise<void>;
  onRemoveLibrary: (libraryPath: string) => Promise<void>;
  onUpgradeToMaterials: (libraryPath: string) => void;
  onOpenRecentNote: () => Promise<void>;
}

export default function HomeView({
  libraries,
  workspacePath,
  lastOpenedNote,
  workspaceError,
  onAddLibrary,
  onOpenLibrary,
  onRemoveLibrary,
  onUpgradeToMaterials,
  onOpenRecentNote,
}: HomeViewProps) {
  useI18n();
  const [removingPath, setRemovingPath] = useState<string | null>(null);

  const removingLibrary = libraries.find((library) => library.path === removingPath);
  return (
    <div className="home-view">
      <div className="home-view-inner">
        <header className="home-hero">
          <div>
          <Text className="home-eyebrow">{t("本地知识工作台 / HOME")}</Text>
          <Title order={1}>{t("把阅读过的内容，变成能继续使用的知识。")}</Title>
          <Text className="home-intro">{t("从一个笔记库开始。原文件留在本地，系统产物跟随笔记库独立保存。")}</Text>
          <Text className="home-workspace-path" size="xs" c="dimmed" title={workspacePath ?? undefined}>{t("系统工作区：")}{workspacePath ?? t("尚未设置")}</Text>
          </div>
          <Button leftSection={<FolderPlus size={16} />} onClick={onAddLibrary}>{t("新建笔记库")}</Button>
        </header>

        {workspaceError ? <Alert icon={<AlertCircle size={16} />} color="red" variant="light" mb="lg">{workspaceError}</Alert> : null}

        {libraries.length === 0 ? (
          <Paper className="home-empty-state" withBorder radius="lg" p="xl">
            <ThemeIcon size={54} radius="xl" variant="light" color="brand"><Library size={25} /></ThemeIcon>
            <Stack gap={6} align="center" maw={440}>
              <Title order={3}>{t("还没有笔记库")}</Title>
              <Text c="dimmed" ta="center">{t("新建笔记库后，所有笔记、附件、备份和系统索引都会收纳在它自己的文件夹中。")}</Text>
              <Text size="xs" c="dimmed" ta="center">{t("系统工作区：")}{workspacePath ?? t("尚未设置")}</Text>
            </Stack>
            <Button leftSection={<FolderPlus size={16} />} onClick={onAddLibrary}>{t("新建笔记库")}</Button>
          </Paper>
        ) : (
          <>
            <div className="home-section-heading">
              <div><Text className="home-section-kicker">SPACES</Text><Title order={2}>{t("你的笔记库")}</Title></div>
              <Text size="sm" c="dimmed">{libraries.length} {t("个已注册空间")}</Text>
            </div>
            <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="md">
              {libraries.map((library) => (
                <LibraryCard
                  key={library.path}
                  library={library}
                  onOpen={() => void onOpenLibrary(library.path)}
                  onRemove={() => setRemovingPath(library.path)}
                  onUpgradeToMaterials={() => onUpgradeToMaterials(library.path)}
                />
              ))}
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt={36}>
              <Paper className="home-context-card" withBorder radius="lg" p="lg">
                <Group justify="space-between" mb="md"><div><Text className="home-section-kicker">CONTINUE</Text><Title order={3}>{t("继续上次阅读")}</Title></div><ThemeIcon variant="light" color="brand"><BookOpen size={17} /></ThemeIcon></Group>
                {lastOpenedNote ? (
                  <Button className="home-recent-note" variant="subtle" color="gray" fullWidth justify="space-between" rightSection={<ArrowRight size={16} />} onClick={() => void onOpenRecentNote()}>
                    <Stack gap={2} align="flex-start" miw={0}><Text fw={600} truncate>{lastPathName(lastOpenedNote)}</Text><Text size="xs" c="dimmed" truncate>{lastOpenedNote}</Text></Stack>
                  </Button>
                ) : <Text size="sm" c="dimmed">{t("打开一篇笔记后，它会出现在这里。")}</Text>}
              </Paper>
              <Paper className="home-context-card" withBorder radius="lg" p="lg">
                <Group justify="space-between" mb="md"><div><Text className="home-section-kicker">NEXT UP</Text><Title order={3}>{t("本期工作台")}</Title></div><ThemeIcon variant="light" color="gray"><Sparkles size={17} /></ThemeIcon></Group>
                <Stack gap="sm">
                  <Group gap="sm" wrap="nowrap"><Check size={16} className="home-check" /><Text size="sm">{t("多笔记库切换已就绪")}</Text></Group>
                  <Group gap="sm" wrap="nowrap"><Text size="sm" c="dimmed">{t("资料入库与附件阅读")}</Text></Group>
                </Stack>
              </Paper>
            </SimpleGrid>
          </>
        )}
      </div>

      <Modal opened={Boolean(removingPath)} onClose={() => setRemovingPath(null)} title={t("移除笔记库注册")} centered>
        <Stack gap="md">
          <Text size="sm">{t("只会移除 Trellora 中的注册项，不会删除或移动磁盘上的文件。")}</Text>
          <Text fw={650}>{removingLibrary?.alias}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemovingPath(null)}>{t("取消")}</Button>
            <Button color="red" leftSection={<Trash2 size={15} />} onClick={() => {
              if (!removingPath) return;
              void onRemoveLibrary(removingPath).finally(() => setRemovingPath(null));
            }}>{t("移除注册")}</Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function LibraryCard({
  library,
  onOpen,
  onRemove,
  onUpgradeToMaterials,
}: {
  library: LibrarySummary;
  onOpen: () => void;
  onRemove: () => void;
  onUpgradeToMaterials: () => void;
}) {
  useI18n();
  const indexLabel = library.exists ? t("可用") : t("不可用");
  return (
    <Card className={`library-card ${library.isActive ? 'active' : ''} ${!library.exists ? 'missing' : ''}`} withBorder radius="lg" padding="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" miw={0}>
          <ThemeIcon className="library-card-icon" size={42} radius="md" variant={library.isActive ? 'filled' : 'light'} color={library.isActive ? 'brand' : 'gray'}><FileText size={19} /></ThemeIcon>
          <Stack gap={3} miw={0}>
            <Group gap="xs" wrap="nowrap"><Title order={3}>{library.alias}</Title>{library.isActive ? <Badge size="xs" color="brand">{t("当前")}</Badge> : null}</Group>
            <Text className="library-card-path" size="xs" c="dimmed" title={library.path}>{library.path}</Text>
          </Stack>
        </Group>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={t("{0} 操作", { '0': library.alias })}><Ellipsis size={17} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<ArrowRight size={15} />} disabled={!library.exists} onClick={onOpen}>{t("打开笔记")}</Menu.Item>
            <Menu.Item leftSection={<ArrowUpRight size={15} />} disabled={!library.exists} onClick={onUpgradeToMaterials}>{t("升级为资料库")}</Menu.Item>
            <Tooltip label={t("将在 P3 开放")} withArrow position="left"><span><Menu.Item disabled leftSection={<BotIcon />}>{t("问 AI")}</Menu.Item></span></Tooltip>
            <Tooltip label={t("将在 P4 开放")} withArrow position="left"><span><Menu.Item disabled leftSection={<Sparkles size={15} />}>{t("生成 Wiki")}</Menu.Item></span></Tooltip>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<Trash2 size={15} />} onClick={onRemove}>{t("移除注册")}</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <SimpleGrid cols={3} spacing="xs" mt="lg">
        <Metric label={t("笔记")} value={`${library.noteCount}`} icon={<FileText size={14} />} />
        <Metric label={t("附件")} value={`${library.attachmentCount}`} icon={<FolderPlus size={14} />} muted />
        <Metric label={t("状态")} value={indexLabel} icon={<Gauge size={14} />} color={library.exists ? 'teal' : 'red'} />
      </SimpleGrid>

      <Group justify="space-between" mt="lg" pt="md" className="library-card-footer">
        <Group gap={6}><span className={`library-status-dot ${library.exists ? 'ready' : 'missing'}`} /><Text size="xs" c={library.exists ? 'dimmed' : 'red'}>{library.exists ? t("最近打开 {0}", { '0': formatDate(library.lastOpenedAt) }) : t("路径不可用")}</Text></Group>
        <Button variant={library.isActive ? 'filled' : 'light'} size="xs" rightSection={<ArrowRight size={14} />} disabled={!library.exists} onClick={onOpen}>{library.isActive ? t("进入笔记") : t("打开")}</Button>
      </Group>
    </Card>
  );
}

function Metric({ label, value, icon, color = 'gray', muted = false }: { label: string; value: string; icon: ReactNode; color?: string; muted?: boolean }) {
  useI18n();
  return <Stack className={`library-metric ${muted ? 'muted' : ''}`} gap={3}><Group gap={5}><span className={`metric-icon ${color}`}>{icon}</span><Text size="xs" c="dimmed">{label}</Text></Group><Text fw={700} size="lg">{value}</Text></Stack>;
}

function BotIcon() {
  useI18n();
  return <span className="menu-placeholder-icon" aria-hidden="true">AI</span>;
}

function lastPathName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("刚刚");
  return new Intl.DateTimeFormat(getAppLanguage(), { month: 'numeric', day: 'numeric' }).format(date);
}
