import type { ReleaseCheckResult } from '../shared/releaseCheck';
const parse = (value: string) => { const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value); if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) return undefined; return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') }; };
export function compareVersions(left: string, right: string): number | undefined {
  const a = parse(left), b = parse(right); if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) { const x = a.prerelease[index], y = b.prerelease[index]; if (x === y) continue; if (x === undefined || y === undefined) return x === undefined ? -1 : 1; const numericX = /^\d+$/u.test(x), numericY = /^\d+$/u.test(y); if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1; if (numericX !== numericY) return numericX ? -1 : 1; return x > y ? 1 : -1; }
  return 0;
}
/** User-triggered, bounded public metadata request; never receives application credentials or user content. */
export class ReleaseChecker {
  private inFlight?: Promise<ReleaseCheckResult>;
  private cache?: ReleaseCheckResult;
  constructor(private readonly options: { repositoryUrl: string; version: string; fetch?: typeof fetch; now?: () => number }) {}
  check(): Promise<ReleaseCheckResult> {
    if (this.inFlight) return this.inFlight;
    if (this.cache && (this.options.now?.() ?? Date.now()) - Date.parse(this.cache.checkedAt) < 5 * 60_000) return Promise.resolve({ ...this.cache, cached: true });
    const request = this.execute().then(result => { this.cache = result; return result; }).finally(() => { this.inFlight = undefined; }); this.inFlight = request; return request;
  }
  private async execute(): Promise<ReleaseCheckResult> {
    const checkedAt = new Date(this.options.now?.() ?? Date.now()).toISOString(); const base = { currentVersion: this.options.version, checkedAt };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const repository = new URL(this.options.repositoryUrl); const match = /^\/([\w.-]+)\/([\w.-]+)\/?$/u.exec(repository.pathname);
      if (repository.hostname !== 'github.com' || repository.protocol !== 'https:' || !match) throw new Error('INVALID_RELEASE');
      const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Trellora-release-check', 'X-GitHub-Api-Version': '2026-03-10' }, signal: controller.signal, redirect: 'error' });
      if (response.status === 404) return { ...base, state: 'unavailable', code: 'NO_RELEASE' };
      if ([403, 429].includes(response.status)) return { ...base, state: 'unavailable', code: 'RATE_LIMITED' };
      if (!response.ok || !response.body) throw new Error('NETWORK_ERROR');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 ** 2) throw new Error('INVALID_RELEASE'); chunks.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
      const release = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || parse(release.tag_name)?.prerelease || typeof release.html_url !== 'string') throw new Error('INVALID_RELEASE');
      const comparison = compareVersions(release.tag_name, this.options.version), url = new URL(release.html_url);
      if (comparison === undefined || url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${match[1]}/${match[2]}/releases/tag/`) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_RELEASE');
      return { ...base, state: comparison > 0 ? 'available' : 'current', latestVersion: release.tag_name.replace(/^v/u, ''), releaseUrl: url.href };
    } catch (error) { return { ...base, state: 'unavailable', code: controller.signal.aborted ? 'TIMEOUT' : error instanceof Error && error.message === 'INVALID_RELEASE' ? 'INVALID_RELEASE' : 'NETWORK_ERROR' }; }
    finally { clearTimeout(timer); }
  }
}
