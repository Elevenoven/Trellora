import { readFileSync } from 'node:fs';
import path from 'node:path';

/** All release probes resolve the same current package instead of an old brand directory. */
export function releasePaths(root = process.cwd(), override) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const output = path.resolve(root, manifest.build.directories.output);
  return { manifest, output, unpacked: path.resolve(override || path.join(output, 'win-unpacked')),
    artifactName: `${manifest.build.productName}-${manifest.version}-portable-x64.exe` };
}
