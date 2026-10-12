import { compareVersions, isTrustedReleaseUrl, type ReleaseChecker } from './releaseCheck';
import type { ReleaseCheckOptions, ReleaseCheckResult, ReleaseDistribution, ReleaseOpenResult, StartupReleaseCheckSnapshot } from '../shared/releaseCheck';

/** 本次主进程唯一的启动查询与展示资格；所有状态都留在内存，不修改用户数据。 */
export class ReleaseUpdateCoordinator {
  private startupAttempt?: Promise<void>;
  private inFlight?: Promise<ReleaseCheckResult>;
  private latestResult?: ReleaseCheckResult;
  private readonly shownVersions = new Set<string>();
  private readonly records = new Map<string, ReleaseCheckResult>();

  constructor(private readonly options: {
    checker: ReleaseChecker;
    repositoryUrl: string;
    enabled: boolean;
    distribution: ReleaseDistribution;
    openExternal: (url: string) => Promise<void>;
    onChecked?: (result: ReleaseCheckResult) => void;
  }) {}

  /** 自动与手动查询共用在途请求；手动结果同时更新 reload 时读取的快照。 */
  check(options: ReleaseCheckOptions = {}): Promise<ReleaseCheckResult> {
    if (this.inFlight) return this.inFlight;
    const request = this.options.checker.check(options).then(result => {
      this.latestResult = structuredClone(result);
      if (result.state !== 'unavailable' && result.latestVersion) {
        this.records.delete(result.latestVersion);
        this.records.set(result.latestVersion, structuredClone(result));
        if (this.records.size > 5) this.records.delete(this.records.keys().next().value!);
      }
      this.options.onChecked?.(result);
      return result;
    }).finally(() => { this.inFlight = undefined; });
    this.inFlight = request;
    return request;
  }

  /** 一次启动只做一次自动尝试；无论失败、重复挂载或页面刷新都不再次自动联网。 */
  async getStartupCheck(): Promise<StartupReleaseCheckSnapshot> {
    if (this.options.enabled) {
      this.startupAttempt ??= this.check().then(() => undefined);
      await this.startupAttempt;
    }
    return {
      enabled: this.options.enabled, distribution: this.options.distribution,
      result: this.latestResult ? structuredClone(this.latestResult) : undefined,
      startupNoticeShown: Boolean(this.latestResult?.latestVersion && this.shownVersions.has(this.latestResult.latestVersion)),
    };
  }

  /** 校验后原子领取版本资格；手动展示可以忽略返回值，但同样留下本次启动的标记。 */
  claimStartupNotice(version: unknown): boolean {
    const key = this.versionKey(version), result = key ? this.records.get(key) : undefined;
    const comparison = result && compareVersions(key!, result.currentVersion);
    if (!key || result?.state !== 'available' || comparison === undefined || comparison <= 0 || this.shownVersions.has(key)) return false;
    this.shownVersions.add(key);
    return true;
  }

  /** 下载固定交给系统浏览器；本方法不下载文件，也不判断浏览器下载是否完成。 */
  openDownload(version: unknown): Promise<ReleaseOpenResult> {
    return this.open(version, true);
  }

  /** 发布页与下载统一复核来源，绕过应用普通外链的内嵌浏览器偏好。 */
  openPage(version: unknown): Promise<ReleaseOpenResult> {
    return this.open(version, false);
  }

  /** 输入只作为有限长度的版本键，不能将对象或地址透传给系统浏览器。 */
  private versionKey(version: unknown): string | undefined {
    return typeof version === 'string' && version.length <= 200 ? version.replace(/^v/u, '') : undefined;
  }

  /** 只查找主进程已验证记录，不接受 renderer 传入的 URL。 */
  private async open(version: unknown, download: boolean): Promise<ReleaseOpenResult> {
    const key = this.versionKey(version), result = key ? this.records.get(key) : undefined;
    if (!result?.releaseTag || !result.releaseUrl) return { ok: false, code: 'RELEASE_UNAVAILABLE' };
    if (download && (this.options.distribution !== 'portable' || !result.portableAsset)) return { ok: false, code: 'ASSET_UNAVAILABLE' };
    const asset = download ? result.portableAsset : undefined;
    const url = asset?.browserDownloadUrl ?? result.releaseUrl;
    if (!isTrustedReleaseUrl(this.options.repositoryUrl, result.releaseTag, url, asset?.name)) return { ok: false, code: download ? 'ASSET_UNAVAILABLE' : 'RELEASE_UNAVAILABLE' };
    try { await this.options.openExternal(url); return { ok: true }; }
    catch { return { ok: false, code: 'OPEN_FAILED' }; }
  }
}
