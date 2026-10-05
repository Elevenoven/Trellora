import fs from 'node:fs/promises';
import path from 'node:path';
import { build, Platform } from 'electron-builder';

/** Package the isolated current bundles without replacing the developer's running app. */
export async function buildNoteTestPackage(temporary) {
  const root = process.cwd(), manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const electron = JSON.parse(await fs.readFile('node_modules/electron/package.json', 'utf8'));
  const output = path.join(temporary, 'package');
  const configFile = path.join(temporary, 'electron-builder-note-test.json');
  // Passing an object merges the package's arrays and duplicates resource destinations.
  await fs.writeFile(configFile, JSON.stringify({
    ...manifest.build,
    extends: null,
    electronVersion: electron.version,
    directories: { output },
    asarUnpack: [...manifest.build.asarUnpack, '**/dist-electron/noteIndexWorker.js', '**/dist-electron/mammothWorker.js'],
    files: [
      { from: path.join(temporary, 'dist-electron'), to: 'dist-electron', filter: ['**/*'] },
      { from: path.join(temporary, 'dist'), to: 'dist', filter: ['**/*'] },
      'package.json', 'node_modules/better-sqlite3/**/*', 'node_modules/bindings/**/*',
      'node_modules/file-uri-to-path/**/*', 'node_modules/sqlite-vec-windows-x64/**/*',
    ],
    extraResources: manifest.build.extraResources.map(resource => ({ ...resource, from: path.resolve(resource.from) })),
  }, null, 2));
  await build({ projectDir: root, targets: Platform.WINDOWS.createTarget('dir'), config: configFile });
  const executable = path.join(output, 'win-unpacked', 'Trellora.exe');
  await fs.access(executable);
  await fs.access(path.join(output, 'win-unpacked/resources/app.asar.unpacked/dist-electron/noteIndexWorker.js'));
  return executable;
}
