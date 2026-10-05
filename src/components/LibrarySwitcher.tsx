import { t, useI18n } from '../i18n';
import { Badge, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { ArrowRight, Check, ChevronDown, FolderPlus, Library } from 'lucide-react';
import type { LibrarySummary } from '../electron';
import './LibrarySwitcher.css';

interface LibrarySwitcherProps {
  libraries: LibrarySummary[];
  activeLibraryPath: string | null;
  onActivate: (libraryPath: string) => void;
  onAddLibrary: () => void;
  onOpenLibraries: () => void;
}

export default function LibrarySwitcher({
  libraries,
  activeLibraryPath,
  onActivate,
  onAddLibrary,
  onOpenLibraries,
}: LibrarySwitcherProps) {
  useI18n();
  const activeLibrary = libraries.find((library) => library.path === activeLibraryPath);
  return (
    <div className="library-switcher-shell">
      <Menu shadow="md" width={300} position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            className="library-switcher"
            variant="subtle"
            color="gray"
            fullWidth
            justify="flex-start"
            rightSection={<ChevronDown size={14} />}
            leftSection={<Library size={15} />}
            aria-label={t("切换笔记库")}
          >
            <Text component="span" size="sm" fw={650} truncate className="library-switcher-copy" title={activeLibrary?.path}>{activeLibrary?.alias ?? t("选择笔记库")}</Text>
          </Button>
        </Menu.Target>
        <Menu.Dropdown className="library-switcher-dropdown">
          <Menu.Label>{t("切换笔记库")}</Menu.Label>
          {libraries.length === 0 ? <Menu.Item disabled>{t("还没有注册笔记库")}</Menu.Item> : null}
          {libraries.map((library) => (
            <Menu.Item
              key={library.path}
              leftSection={library.path === activeLibraryPath ? <Check size={15} /> : <span className={`library-status-dot ${library.exists ? 'ready' : 'missing'}`} />}
              onClick={() => library.exists && onActivate(library.path)}
              disabled={!library.exists}
              title={library.path}
            >
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Stack gap={0} miw={0}>
                  <Text size="sm" fw={600} truncate>{library.alias}</Text>
                  {libraries.filter((item) => item.alias === library.alias).length > 1 ? <Text size="xs" c="dimmed" truncate>{library.path}</Text> : null}
                </Stack>
                <Badge size="xs" variant="light" color={library.exists ? 'gray' : 'red'}>{library.exists ? t("{0} 篇", { '0': library.noteCount }) : t("不可用")}</Badge>
              </Group>
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item leftSection={<Library size={15} />} rightSection={<ArrowRight size={14} />} onClick={onOpenLibraries}>{t("管理全部笔记库")}</Menu.Item>
          <Menu.Item leftSection={<FolderPlus size={15} />} onClick={onAddLibrary} c="dimmed">{t("新建笔记库")}</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
