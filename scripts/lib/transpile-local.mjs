import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Compile the real relative dependency graph once, preserving module identity.
export function transpileLocalModules(rootDir, compiledRoot, entries) {
  const visited = new Set();
  function visit(relativePath) {
    if (visited.has(relativePath)) return;
    visited.add(relativePath);
    const sourcePath = path.join(rootDir, relativePath);
    const source = readFileSync(sourcePath, 'utf8');
    const outputPath = path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText, 'utf8');
    for (const imported of ts.preProcessFile(source).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const base = path.resolve(path.dirname(sourcePath), imported.fileName);
      const candidate = [base + '.ts', path.join(base, 'index.ts')].find(existsSync);
      if (candidate) visit(path.relative(rootDir, candidate));
    }
  }
  entries.forEach(visit);
}
