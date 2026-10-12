export interface ReleaseAssetInfo {
  name: string;
  size: number;
  browserDownloadUrl: string;
}

export interface ReleaseCheckResult {
  state: 'current' | 'available' | 'unavailable';
  currentVersion: string;
  latestVersion?: string;
  releaseTag?: string;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  releaseUrl?: string;
  portableAsset?: ReleaseAssetInfo;
  checkedAt: string;
  code?: 'NO_RELEASE' | 'RATE_LIMITED' | 'TIMEOUT' | 'INVALID_RELEASE' | 'NETWORK_ERROR';
  cached?: boolean;
}

export interface ReleaseCheckOptions { force?: boolean }
export type ReleaseDistribution = 'portable' | 'other';

export interface StartupReleaseCheckSnapshot {
  enabled: boolean;
  distribution: ReleaseDistribution;
  result?: ReleaseCheckResult;
  startupNoticeShown: boolean;
}

export type ReleaseOpenResult = { ok: true } | {
  ok: false;
  code: 'RELEASE_UNAVAILABLE' | 'ASSET_UNAVAILABLE' | 'OPEN_FAILED';
};
