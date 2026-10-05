import { author, build, homepage, version } from '../package.json';

/** 关于页与主进程共用发布元数据，避免开发模式误用 Electron 的版本。 */
export const APP_INFO = {
  name: build.productName,
  version,
  author,
  repositoryUrl: homepage,
};
