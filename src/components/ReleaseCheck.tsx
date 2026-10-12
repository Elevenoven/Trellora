import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import type { ReleaseUpdateController } from '../hooks/useReleaseUpdate';
import { t, useI18n } from '../i18n';
const failures = { NO_RELEASE: '当前仓库尚无正式发布版本。', RATE_LIMITED: '版本查询受限，请稍后再试。', TIMEOUT: '查询超时，请检查网络后重试。', INVALID_RELEASE: '发布信息格式无法识别，请到项目发布页查看。', NETWORK_ERROR: '无法获取发布信息，请检查网络后重试。' };
/** 设置页与启动提示共享查询结果，手动重试可以立即刷新失败状态。 */
export default function ReleaseCheck({ update }: { update: ReleaseUpdateController }) {
  useI18n(); const { result } = update;
  return <Stack gap="xs"><Group><Button size="xs" variant="default" loading={update.checking} onClick={() => void update.check()}>{t('检查新版本')}</Button><Text size="xs" c="dimmed">{t('正式版每次启动检查公开发布信息；也可以在这里手动检查。')}</Text></Group>
    {result && <Alert color={result.state === 'unavailable' ? 'yellow' : 'blue'}><Stack gap="xs"><Text size="sm">{result.state === 'unavailable' ? t(failures[result.code ?? 'NETWORK_ERROR']) : result.state === 'available' ? `${t('发现新版本：')}${result.latestVersion}` : `${t('当前版本已是最新正式版：')}${result.currentVersion}`}</Text><Text size="xs">{t('查询时间：')}{new Date(result.checkedAt).toLocaleString()}{result.cached ? ` · ${t('缓存结果')}` : ''}</Text>{result.state === 'available' && <Button size="xs" variant="light" onClick={update.review}>{t('查看更新详情')}</Button>}</Stack></Alert>}
  </Stack>;
}
