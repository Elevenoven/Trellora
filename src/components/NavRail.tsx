import { t, useI18n } from '../i18n';
import { Stack, Text, ThemeIcon, Tooltip, UnstyledButton, Menu } from '@mantine/core';
import { FileText, FolderOpen, Library, Map, MessageSquare, Settings, Sparkles, Upload } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import BrandMark from './BrandMark';
import './NavRail.css';

export type MainView = 'home' | 'notes' | 'sources' | 'wiki' | 'graph' | 'libraries' | 'settings';

interface NavRailProps {
  activeView: MainView;
  tourSelected?: MainView;
  onNavigate: (view: MainView) => void;
  onOpenSettings: () => void;
  onOpenFile?: () => void;
  onRecoverFiles?: () => void;
  onRecentFiles?: () => void;
  onPendingFiles?: () => void;
  pendingFileCount?: number;
}

interface NavItem {
  id: MainView;
  label: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { id: 'home', label: '助手', icon: MessageSquare },
  { id: 'notes', label: '笔记', icon: FileText },
  { id: 'sources', label: '资料', icon: Upload },
  { id: 'wiki', label: 'Wiki', icon: Sparkles },
  { id: 'graph', label: '地图', icon: Map },
];

/** 全局导航独立于笔记侧栏，折叠侧栏后仍可管理全部笔记库。 */
export default function NavRail({ activeView, tourSelected, onNavigate, onOpenSettings, onOpenFile, onRecoverFiles, onRecentFiles, onPendingFiles, pendingFileCount = 0 }: NavRailProps) {
  useI18n();
  return (
    <aside className="app-nav-rail" aria-label={t("空间导航")}>
      <Stack className="app-nav-rail-top" gap={6} align="center">
        <Tooltip label="Trellora" position="right" withArrow>
          <ThemeIcon className="app-nav-brand" size={30} radius={7} variant="transparent" aria-label="Trellora">
            <BrandMark size={30} />
          </ThemeIcon>
        </Tooltip>
        <div className="app-nav-divider" />
        <Stack gap={4} align="center">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Tooltip key={item.id} label={item.id === 'home' ? t("AI 助手") : t(item.label)} position="right" withArrow>
                <UnstyledButton
                  className={`app-nav-item ${activeView === item.id ? 'active' : ''}`}
                  data-onboarding-anchor={`menu-${item.id}`}
                  data-tour-selected={tourSelected === item.id || undefined}
                  aria-label={t(item.label)}
                  aria-current={activeView === item.id ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  <Text component="span" className="app-nav-item-label">{t(item.label)}</Text>
                </UnstyledButton>
              </Tooltip>
            );
          })}
        </Stack>
      </Stack>

      <Stack className="app-nav-rail-bottom" gap={4} align="center">
        {onOpenFile && <Menu position="right-end"><Menu.Target><UnstyledButton className="app-nav-item" aria-label={t('打开文件')}><FolderOpen size={16} strokeWidth={1.8} /><Text component="span" className="app-nav-item-label">{t('打开')}{pendingFileCount > 0 ? ` ${pendingFileCount}` : ''}</Text></UnstyledButton></Menu.Target><Menu.Dropdown><Menu.Item onClick={onOpenFile}>{t('打开文件')} (Ctrl+O)</Menu.Item><Menu.Item onClick={onRecentFiles}>{t("最近文件")}</Menu.Item><Menu.Item onClick={onRecoverFiles}>{t('恢复独立文件草稿')}</Menu.Item><Menu.Item onClick={onPendingFiles}>{t('待打开文件')} ({pendingFileCount})</Menu.Item></Menu.Dropdown></Menu>}
        <Tooltip label={t("管理全部笔记库")} position="right" withArrow>
          <UnstyledButton data-onboarding-anchor="menu-libraries" data-tour-selected={tourSelected === 'libraries' || undefined} className={`app-nav-item ${activeView === 'libraries' ? 'active' : ''}`} aria-label={t("笔记库管理")} aria-current={activeView === 'libraries' ? 'page' : undefined} onClick={() => onNavigate('libraries')}>
            <Library size={16} strokeWidth={1.8} />
            <Text component="span" className="app-nav-item-label">{t("笔记库")}</Text>
          </UnstyledButton>
        </Tooltip>
        <div className="app-nav-divider" />
        <Tooltip label={t("设置")} position="right" withArrow>
          <UnstyledButton data-onboarding-anchor="menu-settings" data-tour-selected={tourSelected === 'settings' || undefined} className={`app-nav-item ${activeView === 'settings' ? 'active' : ''}`} aria-label={t("设置")} aria-current={activeView === 'settings' ? 'page' : undefined} onClick={onOpenSettings}>
            <Settings size={16} strokeWidth={1.8} />
            <Text component="span" className="app-nav-item-label">{t("设置")}</Text>
          </UnstyledButton>
        </Tooltip>
      </Stack>
    </aside>
  );
}
