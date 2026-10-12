import { Alert, Badge, Button, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { ArrowRight, Download, ExternalLink } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { ReleaseUpdateController } from '../hooks/useReleaseUpdate';
import { t, useI18n } from '../i18n';
import './ReleaseUpdateModal.css';

/** 将可用高度分给正文，让长说明滚动时底部操作仍然留在窗口内。 */
function ReleaseModalScrollArea({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="release-update-scroll" style={style}>{children}</div>;
}

/** 更新提示只展示已验证结果，下载与普通关闭由全局控制器负责。 */
export default function ReleaseUpdateModal({ update }: { update: ReleaseUpdateController }) {
  const { language } = useI18n();
  const release = update.dialogResult;
  const portable = update.distribution === 'portable';
  const canDownload = portable && Boolean(release?.portableAsset);
  const notes = release?.releaseNotes?.trim();
  const date = release?.publishedAt && Number.isFinite(Date.parse(release.publishedAt))
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(release.publishedAt)) : undefined;
  return <Modal.Root opened={update.opened} onClose={update.dismiss} centered size={520} scrollAreaComponent={ReleaseModalScrollArea}
    classNames={{ content: 'release-update-content', body: 'release-update-body' }} trapFocus returnFocus closeOnEscape closeOnClickOutside>
    <Modal.Overlay />
    <Modal.Content data-release-update-modal data-testid="release-update-modal">
      <Modal.Header><Modal.Title>{t('发现 Trellora 新版本')}</Modal.Title><Modal.CloseButton aria-label={t('关闭')} /></Modal.Header>
      <Modal.Body>
    <Stack gap="md" className="release-update-layout">
      <Group gap="sm" className="release-update-versions" aria-label={t('版本信息')}>
        <Stack gap={4}><Text size="xs" c="dimmed">{t('当前版本')}</Text><Text fw={600}>{release?.currentVersion}</Text></Stack>
        <ArrowRight size={18} aria-hidden="true" />
        <Stack gap={4}><Text size="xs" c="dimmed">{t('新版本')}</Text><Badge size="lg" variant="light">{release?.latestVersion}</Badge></Stack>
      </Group>
      {date && <Text size="xs" c="dimmed">{t('发布于 {date}', { date })}</Text>}
      <Stack gap={6} className="release-update-notes-section">
        <Text size="sm" fw={600}>{t('本次更新')}</Text>
        <ScrollArea.Autosize mah={240} type="auto" className="release-update-notes">
          <Text size="sm" className="release-update-notes-text">{notes ? notes.slice(0, 6_000) : t('此版本未提供更新说明，可前往发布页查看。')}</Text>
          {notes && notes.length > 6_000 && <Text size="xs" c="dimmed" mt="sm">{t('完整内容请查看发布页。')}</Text>}
        </ScrollArea.Autosize>
      </Stack>
      <Text size="sm" c="dimmed" className="release-update-guidance">{!portable
        ? t('请前往发布页，选择与你当前使用方式一致的版本。安装版请运行新版安装包升级。')
        : !canDownload ? t('此版本暂未提供可直接下载的便携版，请到发布页查看。')
          : update.downloadLinkOpened ? t('已在系统浏览器中打开下载链接。请等待浏览器下载完成后，再退出软件并替换旧 EXE。')
            : t('下载后请先退出 Trellora，再用新版 EXE 替换旧文件。保留工作区和资料库文件夹。')}</Text>
      {update.openError && <Alert color="yellow" role="status" data-testid="release-open-error">{update.openError}</Alert>}
      <Group justify="space-between" gap="xs" className="release-update-actions">
        <Button variant="subtle" size="xs" leftSection={<ExternalLink size={14} />} disabled={update.opening} onClick={() => void update.openPage()}>
          {t('查看完整发布说明')}
        </Button>
        <Group gap="xs">
          <Button variant="default" data-autofocus onClick={update.dismiss} data-testid="release-later">{t(update.downloadLinkOpened || !portable ? '继续使用' : '稍后')}</Button>
          {canDownload && !update.downloadLinkOpened && <Button leftSection={<Download size={16} />} loading={update.opening} onClick={() => void update.openDownload()} data-testid="release-download">{t('下载便携版')}</Button>}
          {canDownload && update.downloadLinkOpened && <Button onClick={update.requestClose} data-testid="release-exit">{t('已下载，退出软件')}</Button>}
          {!canDownload && <Button loading={update.opening} onClick={() => void update.openPage()} data-testid="release-page">{t('前往发布页')}</Button>}
        </Group>
      </Group>
      {canDownload && update.downloadLinkOpened && <Button size="xs" variant="subtle" disabled={update.opening} onClick={() => void update.openDownload()} data-testid="release-download-again">{t('重新打开下载链接')}</Button>}
    </Stack>
      </Modal.Body>
    </Modal.Content>
  </Modal.Root>;
}
