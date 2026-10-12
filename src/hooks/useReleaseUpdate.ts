import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_INFO } from '../../shared/appInfo';
import type { ReleaseCheckResult, ReleaseDistribution } from '../../shared/releaseCheck';
import { t } from '../i18n';

type PendingNotice = { result: ReleaseCheckResult; manual: boolean };

/** 观察现有模态/菜单的实际可见性，让更新提示等待它们结束，避免争抢焦点。 */
function hasPriorityOverlay(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], .simple-modal, .mantine-Menu-dropdown, .mantine-Popover-dropdown')]
    .some(element => !element.closest('[data-release-update-modal]') && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
}

/** 全局版本状态与展示调度；仅在内存中保存，不修改用户数据或启动偏好。 */
export function useReleaseUpdate({ readyToCheck, readyToPrompt, blocked }: { readyToCheck: boolean; readyToPrompt: boolean; blocked: boolean }) {
  const [result, setResult] = useState<ReleaseCheckResult>();
  const [checking, setChecking] = useState(false);
  const [distribution, setDistribution] = useState<ReleaseDistribution>('other');
  const [pending, setPending] = useState<PendingNotice>();
  const [dialogResult, setDialogResult] = useState<ReleaseCheckResult>();
  const [dialogRequested, setDialogRequested] = useState(false);
  const [downloadLinkOpened, setDownloadLinkOpened] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string>();
  const [foreground, setForeground] = useState(() => document.visibilityState === 'visible' && document.hasFocus());
  const [priorityOverlay, setPriorityOverlay] = useState(false);
  const mounted = useRef(false);
  const manualRequested = useRef(false);
  const sequence = useRef(0);
  const openingSequence = useRef(0);
  const claiming = useRef<PendingNotice>();
  const pendingRef = useRef(pending);
  const dialogRef = useRef(dialogResult);
  useEffect(() => { pendingRef.current = pending; dialogRef.current = dialogResult; }, [pending, dialogResult]);

  useEffect(() => {
    mounted.current = true;
    const updateForeground = () => setForeground(document.visibilityState === 'visible' && document.hasFocus());
    const updateOverlay = () => setPriorityOverlay(hasPriorityOverlay());
    window.addEventListener('focus', updateForeground); window.addEventListener('blur', updateForeground);
    document.addEventListener('visibilitychange', updateForeground);
    const observer = new MutationObserver(updateOverlay);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'role'] });
    updateForeground(); updateOverlay();
    return () => {
      mounted.current = false; observer.disconnect();
      window.removeEventListener('focus', updateForeground); window.removeEventListener('blur', updateForeground);
      document.removeEventListener('visibilitychange', updateForeground);
    };
  }, []);

  /** 启动请求不进入本地初始化等待；StrictMode/reload 的去重由主进程保障。 */
  useEffect(() => {
    if (!readyToCheck || !window.electronAPI?.getStartupReleaseCheck) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (manualRequested.current) return;
      void window.electronAPI.getStartupReleaseCheck().then(snapshot => {
        if (cancelled || !mounted.current) return;
        setDistribution(snapshot.distribution);
        if (manualRequested.current) return;
        setResult(snapshot.result);
        if (snapshot.enabled && snapshot.result?.state === 'available' && !snapshot.startupNoticeShown) {
          setPending({ result: snapshot.result, manual: false });
        }
      }).catch(() => {
        if (!cancelled && mounted.current && !manualRequested.current) setResult({ state: 'unavailable', currentVersion: APP_INFO.version, checkedAt: new Date().toISOString(), code: 'NETWORK_ERROR' });
      });
    }, 1_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [readyToCheck]);

  /** 仅在可展示时领取资格；临时屏障出现后保留对话内容，解除时继续显示。 */
  useEffect(() => {
    const version = pending?.result.latestVersion;
    if (!pending || !readyToPrompt || blocked || priorityOverlay || !foreground || claiming.current === pending || !version) return;
    const notice = pending;
    claiming.current = notice;
    void window.electronAPI.claimStartupReleaseNotice(version).then(granted => {
      if (!mounted.current || pendingRef.current !== notice) return;
      if (granted || notice.manual) {
        openingSequence.current++;
        setDialogResult(notice.result); setDialogRequested(true); setDownloadLinkOpened(false); setOpenError(undefined); setOpening(false);
      }
      setPending(undefined);
    }).catch(() => {
      if (mounted.current && pendingRef.current === notice) setPending(undefined);
    }).finally(() => { if (claiming.current === notice) claiming.current = undefined; });
  }, [pending, readyToPrompt, blocked, priorityOverlay, foreground]);

  /** 用户查询立即刷新，自动结果不覆盖手动结果；发行方式由同一个主进程快照提供。 */
  const check = useCallback(async () => {
    manualRequested.current = true;
    const request = ++sequence.current;
    openingSequence.current++;
    setChecking(true); setPending(undefined); setDialogRequested(false); setOpening(false); setOpenError(undefined);
    try {
      const [next, snapshot] = await Promise.all([window.electronAPI.checkLatestRelease({ force: true }), window.electronAPI.getStartupReleaseCheck()]);
      if (!mounted.current || sequence.current !== request) return;
      setDistribution(snapshot.distribution); setResult(next);
      if (next.state === 'available') setPending({ result: next, manual: true });
    } catch {
      if (mounted.current && sequence.current === request) setResult({ state: 'unavailable', currentVersion: APP_INFO.version, checkedAt: new Date().toISOString(), code: 'NETWORK_ERROR' });
    } finally { if (mounted.current && sequence.current === request) setChecking(false); }
  }, []);

  /** 设置页可再次查看同一版本，不重新触发自动提示或增加网络请求。 */
  const review = useCallback(() => {
    if (result?.state === 'available') { manualRequested.current = true; setPending({ result, manual: true }); }
  }, [result]);

  const dismiss = useCallback(() => {
    openingSequence.current++;
    // 关闭动画期间保留版本和说明，避免退出过渡时短暂出现空内容。
    setPending(undefined); setDialogRequested(false); setOpening(false); setOpenError(undefined);
  }, []);

  /** 成功只代表打开系统浏览器；发布页不进入便携下载确认状态。 */
  const open = useCallback(async (download: boolean) => {
    const version = dialogRef.current?.latestVersion;
    if (!version || opening || !dialogRequested) return;
    const request = ++openingSequence.current;
    setOpening(true); setOpenError(undefined);
    try {
      const response = await (download ? window.electronAPI.openReleaseDownload(version) : window.electronAPI.openReleasePage(version));
      if (!mounted.current || openingSequence.current !== request) return;
      if (response.ok) { if (download) setDownloadLinkOpened(true); }
      else setOpenError(response.code === 'OPEN_FAILED'
        ? t('无法打开系统浏览器，请重试或前往发布页下载。')
        : t('发布信息已不可用，请关闭此窗口后重新检查新版本。'));
    } catch {
      if (mounted.current && openingSequence.current === request) setOpenError(t('无法打开系统浏览器，请重试或前往发布页下载。'));
    } finally { if (mounted.current && openingSequence.current === request) setOpening(false); }
  }, [opening, dialogRequested]);

  /** 先释放更新弹窗的焦点，再进入既有窗口关闭与保存握手，不强制结束进程。 */
  const requestClose = useCallback(() => {
    if (!downloadLinkOpened || !dialogRequested) return;
    dismiss();
    window.setTimeout(() => { void window.electronAPI.requestReleaseUpdateClose().catch(() => undefined); }, 0);
  }, [dismiss, downloadLinkOpened, dialogRequested]);

  return {
    result, checking, check, review, distribution, dialogResult,
    opened: dialogRequested && readyToPrompt && !blocked && !priorityOverlay,
    downloadLinkOpened, opening, openError, dismiss, openDownload: () => open(true), openPage: () => open(false), requestClose,
  };
}

export type ReleaseUpdateController = ReturnType<typeof useReleaseUpdate>;
