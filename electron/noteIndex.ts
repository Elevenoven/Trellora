import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { parseNoteFrontmatter } from '../shared/frontmatter';
import { getFileTypeInfo, type FileKind } from './fileTypes';
import { readTextFile } from './textFile';
import { loadTreeOrder, sortEntriesByTreeOrder, type TreeOrderState } from './treeOrder';
import { extractMarkdownKnowledgeFacts } from './knowledge/markdownAst';

export interface FileNode {
  path: string;
  name: string;
  isDirectory: boolean;
  kind: 'directory' | FileKind;
  extension?: string;
  title?: string;
  children?: FileNode[];
}

export interface HeadingEntry {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  index: number;
}

export interface WikiLinkEntry {
  target: string;
  alias?: string;
}

export interface BacklinkEntry {
  sourcePath: string;
  sourceTitle: string;
  snippet: string;
}

export interface TagSummary {
  tag: string;
  count: number;
}

export interface IndexedNote {
  path: string;
  title: string;
  kind: FileKind;
  extension: string;
  rawMarkdown: string;
  contentMarkdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  headings: HeadingEntry[];
  outgoingLinks: WikiLinkEntry[];
  plainText: string;
  contentHash: string;
  mtimeMs: number;
}

interface HeadingCandidate {
  level: HeadingEntry['level'];
  text: string;
  line: number;
  offset: number;
}

export interface NoteMeta extends IndexedNote {
  backlinks: BacklinkEntry[];
}

export interface NoteIndex {
  libraryPath: string;
  fileTree: FileNode[];
  notes: IndexedNote[];
  notesByPath: Record<string, IndexedNote>;
}

const markdownExtensionPattern = /\.(?:md|markdown)$/i;
const ignoredDirectories = new Set(['.git', '.menghan-backups', '.menghan-meta', 'node_modules']);
const wikiLinkPattern = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
const fencedCodeBlockPattern = /```[\s\S]*?```/g;
const inlineCodePattern = /`[^`\n]*`/g;

export function buildNoteIndex(libraryPath: string): NoteIndex {
  const normalizedLibraryPath = path.resolve(libraryPath);
  const notes: IndexedNote[] = [];
  const treeOrder = loadTreeOrder(normalizedLibraryPath);
  const fileTree = scanDirectory(normalizedLibraryPath, normalizedLibraryPath, notes, treeOrder);
  const notesByPath = Object.fromEntries(notes.map((note) => [note.path, note]));

  return {
    libraryPath: normalizedLibraryPath,
    fileTree,
    notes,
    notesByPath,
  };
}

export function getNoteMeta(index: NoteIndex, filePath: string): NoteMeta {
  const resolvedPath = path.resolve(filePath);
  const note = index.notesByPath[resolvedPath];
  if (!note) {
    throw new Error(`笔记尚未建立索引：${filePath}`);
  }

  return {
    ...note,
    backlinks: getBacklinks(index, resolvedPath),
  };
}

export function getBacklinks(index: NoteIndex, filePath: string): BacklinkEntry[] {
  const resolvedTargetPath = path.resolve(filePath);

  return index.notes
    .filter((note) => note.path !== resolvedTargetPath)
    .flatMap((note) => {
      const matchingLinks = note.outgoingLinks.filter((link) => (
        resolveWikiLink(index, link.target, note.path) === resolvedTargetPath
      ));

      return matchingLinks.map((link) => ({
        sourcePath: note.path,
        sourceTitle: note.title,
        snippet: getWikiLinkSnippet(note.contentMarkdown, link),
      }));
    });
}

export function getAllTags(index: NoteIndex): TagSummary[] {
  const counts = new Map<string, number>();

  for (const note of index.notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}

export function getFilesByTag(index: NoteIndex, tag: string): FileNode[] {
  const normalizedTag = normalizeTag(tag);
  return index.notes
    .filter((note) => note.tags.some((noteTag) => normalizeTag(noteTag) === normalizedTag))
    .map((note) => ({
      path: note.path,
      name: path.basename(note.path),
      isDirectory: false,
      kind: note.kind,
      extension: note.extension,
      title: note.title,
    }));
}

export function resolveWikiLink(index: NoteIndex, target: string, fromPath?: string): string | null {
  const normalizedTarget = normalizeLinkTarget(target);
  if (!normalizedTarget) return null;

  const directPath = resolveDirectPath(index, target.trim().replace(/\\/g, '/'), fromPath);
  if (directPath) return directPath;

  const candidates = index.notes.filter((note) => {
    const basename = normalizeLinkTarget(path.basename(note.path).replace(markdownExtensionPattern, ''));
    const relativePath = normalizeLinkTarget(
      path.relative(index.libraryPath, note.path).replace(/\\/g, '/').replace(markdownExtensionPattern, ''),
    );
    const title = normalizeLinkTarget(note.title);
    return basename === normalizedTarget
      || relativePath === normalizedTarget
      || title === normalizedTarget;
  });

  if (candidates.length === 0) return null;

  if (fromPath) {
    const fromDirectory = path.dirname(path.resolve(fromPath));
    const sameDirectoryCandidate = candidates.find((note) => path.dirname(note.path) === fromDirectory);
    if (sameDirectoryCandidate) return sameDirectoryCandidate.path;
  }

  return candidates.map((note) => note.path).sort((a, b) => a.localeCompare(b))[0] ?? null;
}

export function parseNote(filePath: string, _libraryPath: string): IndexedNote {
  return parseNoteContent(filePath, readTextFile(filePath), fs.statSync(filePath).mtimeMs);
}

/** Parse an already decoded snapshot; callers own file version validation. */
export function parseNoteContent(filePath: string, rawMarkdown: string, mtimeMs: number): IndexedNote {
  const resolvedPath = path.resolve(filePath);
  const typeInfo = getFileTypeInfo(resolvedPath);
  if (!typeInfo) {
    throw new Error(`不支持的笔记文件：${filePath}`);
  }

  if (typeInfo.kind === 'text') {
    return {
      path: resolvedPath,
      title: getPlainTextTitle(resolvedPath),
      kind: typeInfo.kind,
      extension: typeInfo.extension,
      rawMarkdown,
      contentMarkdown: rawMarkdown,
      frontmatter: {},
      tags: [],
      headings: extractHeadings(rawMarkdown),
      outgoingLinks: [],
      plainText: rawMarkdown,
      contentHash: createHash('sha256').update(rawMarkdown, 'utf8').digest('hex'),
      mtimeMs,
    };
  }

  const facts = extractMarkdownKnowledgeFacts(rawMarkdown);
  let contentMarkdown = rawMarkdown;
  try {
    contentMarkdown = parseNoteFrontmatter(rawMarkdown).content;
  } catch {
    // Existing notes must remain loadable even when their frontmatter is malformed.
    // The AST extractor already treats malformed metadata as empty facts.
  }
  const title = getTitle(resolvedPath, facts.frontmatter, facts.headings);

  return {
    path: resolvedPath,
    title,
    kind: typeInfo.kind,
    extension: typeInfo.extension,
    rawMarkdown,
    contentMarkdown,
    frontmatter: facts.frontmatter,
    tags: facts.tags,
    headings: facts.headings,
    outgoingLinks: facts.outgoingLinks,
    plainText: facts.plainText,
    contentHash: facts.contentHash,
    mtimeMs,
  };
}

export function extractWikiLinks(markdown: string): WikiLinkEntry[] {
  const text = stripCode(markdown);
  const links: WikiLinkEntry[] = [];
  let match: RegExpExecArray | null;

  while ((match = wikiLinkPattern.exec(text)) !== null) {
    const target = match[1]?.trim();
    const alias = match[2]?.trim();
    if (!target) continue;
    links.push(alias ? { target, alias } : { target });
  }

  return links;
}

export function extractHeadings(markdown: string): HeadingEntry[] {
  const candidates = [
    ...extractHtmlHeadingCandidates(markdown),
    ...extractMarkdownHeadingCandidates(markdown),
  ].sort((first, second) => first.offset - second.offset);

  return candidates.map((candidate, index) => ({
    id: slugifyHeading(candidate.text, index),
    level: candidate.level,
    text: candidate.text,
    line: candidate.line,
    index,
  }));
}

function extractMarkdownHeadingCandidates(markdown: string): HeadingCandidate[] {
  const maskedMarkdown = maskIgnoredHtmlRegions(markdown);
  const lines = maskedMarkdown.split(/\r?\n/);
  const originalLines = markdown.split(/\r?\n/);
  const candidates: HeadingCandidate[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let offset = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const originalLine = originalLines[index] ?? line;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      offset += originalLine.length + getNewlineLength(markdown, offset + originalLine.length);
      continue;
    }

    if (fence) {
      offset += originalLine.length + getNewlineLength(markdown, offset + originalLine.length);
      continue;
    }

    const atxHeading = line.match(/^ {0,3}(#{1,6})(?!#)(?:[ \t]+|(?=\S))(.+?)\s*#*\s*$/);
    if (atxHeading) {
      addHeadingCandidate(
        candidates,
        atxHeading[1].length as HeadingEntry['level'],
        stripInlineMarkdown(atxHeading[2]),
        index + 1,
        offset,
      );
      offset += originalLine.length + getNewlineLength(markdown, offset + originalLine.length);
      continue;
    }

    const nextLine = lines[index + 1];
    if (nextLine === undefined) {
      offset += originalLine.length + getNewlineLength(markdown, offset + originalLine.length);
      continue;
    }

    const setextUnderline = nextLine.match(/^ {0,3}(=+|-+)\s*$/);
    if (!setextUnderline || !line.trim()) {
      offset += originalLine.length + getNewlineLength(markdown, offset + originalLine.length);
      continue;
    }

    const level = setextUnderline[1][0] === '=' ? 1 : 2;
    addHeadingCandidate(candidates, level, stripInlineMarkdown(originalLine), index + 1, offset);
    offset += originalLine.length + getNewlineLength(markdown, offset + originalLine.length);
    const underline = originalLines[index + 1] ?? nextLine;
    offset += underline.length + getNewlineLength(markdown, offset + underline.length);
    index++;
  }

  return candidates;
}

function extractHtmlHeadingCandidates(markdown: string): HeadingCandidate[] {
  const maskedMarkdown = maskIgnoredHtmlRegions(markdown);
  const candidates: HeadingCandidate[] = [];
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

  for (const match of maskedMarkdown.matchAll(headingPattern)) {
    const level = Number(match[1]) as HeadingEntry['level'];
    const text = decodeHtmlEntities(stripHtmlTags(match[2])).replace(/\s+/g, ' ').trim();
    addHeadingCandidate(candidates, level, text, getLineNumberAt(markdown, match.index ?? 0), match.index ?? 0);
  }

  return candidates;
}

function addHeadingCandidate(
  candidates: HeadingCandidate[],
  level: HeadingEntry['level'],
  rawText: string,
  line: number,
  offset: number,
): void {
  const textContent = rawText.replace(/\s+#+\s*$/, '').trim();
  if (!textContent) return;
  candidates.push({
    level,
    text: textContent,
    line,
    offset,
  });
}

function maskIgnoredHtmlRegions(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, preserveNewlines)
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, preserveNewlines)
    .replace(/<code\b[\s\S]*?<\/code>/gi, preserveNewlines);
}

function preserveNewlines(value: string): string {
  return value.replace(/[^\r\n]/g, ' ');
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }
    return entities[normalized] ?? entity;
  });
}

function getLineNumberAt(value: string, offset: number): number {
  return value.slice(0, offset).split(/\r?\n/).length;
}

function getNewlineLength(value: string, offset: number): number {
  if (offset >= value.length) return 0;
  return value.startsWith('\r\n', offset) ? 2 : 1;
}

function scanDirectory(
  directory: string,
  libraryPath: string,
  notes: IndexedNote[],
  treeOrder: TreeOrderState,
): FileNode[] {
  const nodes = fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => !item.name.startsWith('.') || item.name === '.')
    .filter((item) => !(item.isDirectory() && ignoredDirectories.has(item.name)))
    .flatMap<FileNode>((item) => {
      const fullPath = path.join(directory, item.name);

      if (item.isDirectory()) {
        return [{
          path: fullPath,
          name: item.name,
          isDirectory: true,
          kind: 'directory',
          children: scanDirectory(fullPath, libraryPath, notes, treeOrder),
        }];
      }

      const typeInfo = getFileTypeInfo(item.name);
      if (!typeInfo) return [];

      const note = parseNote(fullPath, libraryPath);
      notes.push(note);
      return [{
        path: fullPath,
        name: item.name,
        isDirectory: false,
        kind: typeInfo.kind,
        extension: typeInfo.extension,
        title: note.title,
      }];
    });

  return sortEntriesByTreeOrder(nodes, libraryPath, directory, treeOrder);
}

function getTitle(filePath: string, frontmatter: Record<string, unknown>, headings: HeadingEntry[]): string {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }

  const firstHeading = headings.find((heading) => heading.level === 1);
  if (firstHeading) return firstHeading.text;

  return getPlainTextTitle(filePath);
}

function getPlainTextTitle(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function getWikiLinkSnippet(markdown: string, link: WikiLinkEntry): string {
  const escapedTarget = escapeRegExp(link.target);
  const escapedAlias = link.alias ? `\\|${escapeRegExp(link.alias)}` : '(?:\\|[^\\]]+)?';
  const pattern = new RegExp(`\\[\\[${escapedTarget}${escapedAlias}\\]\\]`);
  const line = markdown.split(/\r?\n/).find((candidate) => pattern.test(candidate));
  return (line ?? `[[${link.target}${link.alias ? `|${link.alias}` : ''}]]`).trim();
}

function resolveDirectPath(index: NoteIndex, target: string, fromPath?: string): string | null {
  const targetWithExt = markdownExtensionPattern.test(target) ? target : `${target}.md`;
  const candidates = fromPath
    ? [
      path.resolve(path.dirname(fromPath), targetWithExt),
      path.resolve(index.libraryPath, targetWithExt),
    ]
    : [path.resolve(index.libraryPath, targetWithExt)];

  for (const candidate of candidates) {
    const exactMatch = index.notesByPath[candidate];
    if (exactMatch) return exactMatch.path;
    const caseInsensitiveMatch = index.notes.find((note) => note.path.toLowerCase() === candidate.toLowerCase());
    if (caseInsensitiveMatch) return caseInsensitiveMatch.path;
  }
  return null;
}

function normalizeLinkTarget(target: string): string {
  return target
    .trim()
    .replace(/\\/g, '/')
    .replace(markdownExtensionPattern, '')
    .toLowerCase();
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, '');
}

function stripCode(markdown: string): string {
  return markdown
    .replace(fencedCodeBlockPattern, '')
    .replace(inlineCodePattern, '');
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1');
}

function slugifyHeading(text: string, index: number): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `heading-${index + 1}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
