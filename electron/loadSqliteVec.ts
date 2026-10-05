import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/** Native SQLite loading needs a physical DLL path; an ASAR virtual path cannot be loaded. */
export function loadSqliteVec(database: Database.Database): void {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const packaged = resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll') : '';
  if (packaged && fs.existsSync(packaged)) database.loadExtension(packaged);
  else (require('sqlite-vec') as { load(database: Database.Database): void }).load(database);
}
