import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertInsideDirectory, resolveRealAncestors } from './pathGuards';

interface Owner { pid: number; token: string; roots: string[]; }
const lockName = '.trellora-use.lock';
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

/** Directory creation is atomic; stale claims are reclaimed only after the recorded process exited. */
function claim(directory: string, owner: Owner): void {
  try { fs.mkdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = readOwner(directory);
    if (!previous || live(previous.pid)) throw Object.assign(new Error('该工作区或笔记库正在被另一应用实例使用，请关闭该实例或选择其他目录。'), { code: 'DATA_ROOT_IN_USE' });
    release(directory, previous.token);
    fs.mkdirSync(directory);
  }
  try { fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx' }); }
  catch (error) { try { fs.rmdirSync(directory); } catch { /* Never delete an unknown owner's files. */ } throw error; }
}

function readOwner(directory: string): Owner | undefined {
  try {
    const file = path.join(directory, 'owner.json');
    if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16_384) return undefined;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner;
    return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && Array.isArray(owner.roots) ? owner : undefined;
  } catch { return undefined; }
}

function release(directory: string, token: string): void {
  if (readOwner(directory)?.token !== token) return;
  fs.unlinkSync(path.join(directory, 'owner.json'));
  fs.rmdirSync(directory);
}

/** Real-root leases work across userData directories and serialize overlapping roots in one Windows account. */
export class DataRootLocks {
  private readonly owner: Owner = { pid: process.pid, token: randomUUID(), roots: [] };
  private readonly held = new Map<string, string | null>();
  private readonly registry = path.join(os.tmpdir(), 'trellora-data-root-leases');
  private readonly registration = path.join(this.registry, this.owner.token);

  /** Reserve a future migration root without creating files in the empty destination. */
  reserve(roots: readonly string[]): void { this.acquire(roots, false); }

  releaseReservation(root: string): void {
    const resolved = resolveRealAncestors(root).toLowerCase();
    if (this.held.get(resolved) !== null) return;
    this.held.delete(resolved); this.owner.roots = [...this.held.keys()];
    if (fs.existsSync(this.registration)) fs.writeFileSync(path.join(this.registration, 'owner.json'), JSON.stringify(this.owner));
  }

  acquire(roots: readonly string[], createDirectories = true): void {
    const targets = [...new Set(roots.map(root => resolveRealAncestors(root).toLowerCase()))].sort();
    fs.mkdirSync(this.registry, { recursive: true });
    const guard = path.join(this.registry, 'guard');
    claim(guard, this.owner);
    const acquired: string[] = [];
    try {
      for (const name of fs.readdirSync(this.registry)) {
        if (name === 'guard' || name === this.owner.token) continue;
        const other = readOwner(path.join(this.registry, name));
        if (other && !live(other.pid)) { release(path.join(this.registry, name), other.token); continue; }
        if (other && live(other.pid) && targets.some(root => other.roots.some(candidate => inside(root, candidate) || inside(candidate, root)))) {
          throw Object.assign(new Error('工作区或笔记库已被另一实例打开，请关闭该实例后再试。'), { code: 'DATA_ROOT_IN_USE' });
        }
      }
      for (const root of targets) {
        if (this.held.has(root) && (!createDirectories || this.held.get(root) !== null)) continue;
        if (!createDirectories) { this.held.set(root, null); acquired.push(root); continue; }
        fs.mkdirSync(root, { recursive: true });
        const metadata = assertInsideDirectory(path.join(root, '.menghan-meta'), root);
        fs.mkdirSync(metadata, { recursive: true });
        const directory = assertInsideDirectory(path.join(metadata, lockName), root);
        claim(directory, this.owner);
        this.held.set(root, directory);
        acquired.push(root);
      }
      this.owner.roots = [...this.held.keys()];
      if (fs.existsSync(this.registration)) fs.writeFileSync(path.join(this.registration, 'owner.json'), JSON.stringify(this.owner));
      else claim(this.registration, this.owner);
    } catch (error) {
      for (const root of acquired) { const directory = this.held.get(root); if (directory) release(directory, this.owner.token); this.held.delete(root); }
      throw error;
    } finally { release(guard, this.owner.token); }
  }

  releaseAll(): void {
    for (const directory of this.held.values()) if (directory) release(directory, this.owner.token);
    this.held.clear();
    release(this.registration, this.owner.token);
  }
}
