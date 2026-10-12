import type { ReleaseAssetInfo, ReleaseCheckOptions, ReleaseCheckResult } from '../shared/releaseCheck';
const parse = (value: string) => { const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value); if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) return undefined; return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') }; };
export function compareVersions(left: string, right: string): number | undefined {
  const a = parse(left), b = parse(right); if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) { const x = a.prerelease[index], y = b.prerelease[index]; if (x === y) continue; if (x === undefined || y === undefined) return x === undefined ? -1 : 1; const numericX = /^\d+$/u.test(x), numericY = /^\d+$/u.test(y); if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1; if (numericX !== numericY) return numericX ? -1 : 1; return x > y ? 1 : -1; }
  return 0;
}
/** 固定公开仓库来源；同时供查询和浏览器打开前的路径复核使用。 */
function repositoryPath(repositoryUrl: string): string | undefined {
  try {
    const url = new URL(repositoryUrl);
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash
      && /^\/[\w.-]+\/[\w.-]+\/?$/u.test(url.pathname) ? url.pathname.replace(/\/$/u, '') : undefined;
  } catch { return undefined; }
}

/** 只允许当前仓库、当前标签的发布页或指定资产，拒绝任意外部跳转入口。 */
export function isTrustedReleaseUrl(repositoryUrl: string, tag: string, rawUrl: string, assetName?: string): boolean {
  const root = repositoryPath(repositoryUrl);
  if (!root || !parse(tag) || parse(tag)?.prerelease) return false;
  try {
    const url = new URL(rawUrl);
    const expected = assetName ? `${root}/releases/download/${tag}/${assetName}` : `${root}/releases/tag/${tag}`;
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash
      && decodeURIComponent(url.pathname) === expected;
  } catch { return false; }
}

/** 便携包必须唯一、上传完成且版本一致；缺失或不可信时仍可查看正式发布页。 */
function portableAsset(release: Record<string, unknown>, repositoryUrl: string, productName: string, tag: string): ReleaseAssetInfo | undefined {
  const name = `${productName}-${tag.replace(/^v/u, '')}-portable-x64.exe`;
  const matching = Array.isArray(release.assets) ? release.assets.filter((asset: unknown) =>
    asset && typeof asset === 'object' && (asset as Record<string, unknown>).name === name) : [];
  if (matching.length !== 1) return undefined;
  const asset = matching[0] as Record<string, unknown>;
  if (asset.state !== 'uploaded' || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0
    || typeof asset.browser_download_url !== 'string'
    || !isTrustedReleaseUrl(repositoryUrl, tag, asset.browser_download_url, name)) return undefined;
  return { name, size: asset.size, browserDownloadUrl: asset.browser_download_url };
}

/** 有超时和大小上限的公开版本查询；不接收应用凭据或用户内容，失败不阻挡重试。 */
export class ReleaseChecker {
  private inFlight?: Promise<ReleaseCheckResult>;
  private cache?: ReleaseCheckResult;
  constructor(private readonly options: { repositoryUrl: string; version: string; productName?: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }) {}
  check(options: ReleaseCheckOptions = {}): Promise<ReleaseCheckResult> {
    if (this.inFlight) return this.inFlight;
    if (!options.force && this.cache && (this.options.now?.() ?? Date.now()) - Date.parse(this.cache.checkedAt) < 5 * 60_000) return Promise.resolve({ ...this.cache, cached: true });
    const request = this.execute().then(result => { this.cache = result.state === 'unavailable' ? undefined : result; return result; }).finally(() => { this.inFlight = undefined; }); this.inFlight = request; return request;
  }
  private async execute(): Promise<ReleaseCheckResult> {
    const checkedAt = new Date(this.options.now?.() ?? Date.now()).toISOString(); const base = { currentVersion: this.options.version, checkedAt };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const root = repositoryPath(this.options.repositoryUrl);
      if (!root) throw new Error('INVALID_RELEASE');
      const match = /^\/([\w.-]+)\/([\w.-]+)$/u.exec(root)!;
      const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Trellora-release-check', 'X-GitHub-Api-Version': '2026-03-10' }, signal: controller.signal, redirect: 'error' });
      if (response.status === 404) return { ...base, state: 'unavailable', code: 'NO_RELEASE' };
      if ([403, 429].includes(response.status)) return { ...base, state: 'unavailable', code: 'RATE_LIMITED' };
      if (!response.ok || !response.body) throw new Error('NETWORK_ERROR');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 ** 2) throw new Error('INVALID_RELEASE'); chunks.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
      let release: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
        release = decoded as Record<string, unknown>;
      } catch { throw new Error('INVALID_RELEASE'); }
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || parse(release.tag_name)?.prerelease || typeof release.html_url !== 'string') throw new Error('INVALID_RELEASE');
      const comparison = compareVersions(release.tag_name, this.options.version);
      if (comparison === undefined || !isTrustedReleaseUrl(this.options.repositoryUrl, release.tag_name, release.html_url)) throw new Error('INVALID_RELEASE');
      return {
        ...base, state: comparison > 0 ? 'available' : 'current', latestVersion: release.tag_name.replace(/^v/u, ''),
        releaseTag: release.tag_name, releaseUrl: release.html_url,
        releaseName: typeof release.name === 'string' ? release.name.slice(0, 200) : undefined,
        releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 6_001) : undefined,
        publishedAt: typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : undefined,
        portableAsset: portableAsset(release, this.options.repositoryUrl, this.options.productName ?? 'Trellora', release.tag_name),
      };
    } catch (error) { return { ...base, state: 'unavailable', code: controller.signal.aborted ? 'TIMEOUT' : error instanceof Error && error.message === 'INVALID_RELEASE' ? 'INVALID_RELEASE' : 'NETWORK_ERROR' }; }
    finally { clearTimeout(timer); }
  }
}
