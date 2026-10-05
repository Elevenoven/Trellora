import { useState } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import type { ReleaseCheckResult } from '../../shared/releaseCheck';
import { t, useI18n } from '../i18n';
const failures = { NO_RELEASE: '当前仓库尚无正式发布版本。', RATE_LIMITED: '版本查询受限，请稍后再试。', TIMEOUT: '查询超时，请检查网络后重试。', INVALID_RELEASE: '发布信息格式无法识别，请到项目发布页查看。', NETWORK_ERROR: '无法获取发布信息，请检查网络后重试。' };
export default function ReleaseCheck() {
  useI18n(); const [result, setResult] = useState<ReleaseCheckResult>(); const [busy, setBusy] = useState(false);
  const check = async () => { setBusy(true); try { setResult(await window.electronAPI.checkLatestRelease()); } catch { setResult({ state: 'unavailable', currentVersion: '', checkedAt: new Date().toISOString(), code: 'NETWORK_ERROR' }); } finally { setBusy(false); } };
  return <Stack gap="xs"><Group><Button size="xs" variant="default" loading={busy} onClick={() => void check()}>{t('检查新版本')}</Button><Text size="xs" c="dimmed">{t('仅在点击后查询公开发布信息。')}</Text></Group>
    {result && <Alert color={result.state === 'unavailable' ? 'yellow' : 'blue'}><Stack gap="xs"><Text size="sm">{result.state === 'unavailable' ? t(failures[result.code ?? 'NETWORK_ERROR']) : result.state === 'available' ? `${t('发现新版本：')}${result.latestVersion}` : `${t('当前版本已是最新正式版：')}${result.currentVersion}`}</Text><Text size="xs">{t('查询时间：')}{new Date(result.checkedAt).toLocaleString()}{result.cached ? ` · ${t('缓存结果')}` : ''}</Text>{result.state === 'available' && result.releaseUrl && <Button size="xs" variant="light" component="a" href={result.releaseUrl} target="_blank" rel="noopener noreferrer">{t('查看发布说明与下载')}</Button>}<Text size="xs" c="dimmed">{t('升级前先做完整备份，退出应用后更换可执行文件。')}</Text></Stack></Alert>}
  </Stack>;
}
