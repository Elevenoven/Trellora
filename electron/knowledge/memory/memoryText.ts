import { createHash } from 'node:crypto';
import { MEMORY_CONSTANTS } from './memoryConstants';

export const REDACTED_MEMORY_PLACEHOLDER = '【已隐藏】';

const topicNoiseRunes = new Set(['的', '了', '地', '得', '之', '与', '和', '及', '在', '是', '有', '个', '等', '对', '于']);
const topicNoiseSuffixes = ['相关问题', '相关', '问题', '方面', '情况', '事宜', '工作', '方向'];
const sensitivePatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?key)\b\s*[:=＝：]\s*[^\s，。、；：！？,;]+/giu,
  /(?:密码|口令|密钥|秘钥)\s*[:=＝：是为]?\s*[^\s，。、；：！？,;]+/gu,
  /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/gu,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{2,7}\b/gu,
  /\b1[3-9]\d{9}\b/gu,
  /\b[A-Za-z0-9_-]{40,}\b/gu,
];

// Direct sentence-start requests may include “你先” or “请先”; quoted/conditional mentions stay excluded.
const explicitPrefixPattern = /^\s*(?:请你帮我记住|请帮我记住|请你先记住|请你记住|请先记住|你先记住|帮我记住|请记住|记住)\s*[:：,，]?\s*(.+)$/u;
const explicitEnglishPrefixPattern = /^\s*(?:remember\s+that|remember|please\s+remember\s+that|please\s+remember|note\s+that|keep\s+in\s+mind\s+that)\s*(?::|,|\s+)\s*(.+)$/iu;

/** Removes prompt-structuring whitespace and enforces the canonical rune limit. */
export function sanitizeMemoryContent(value: string): string {
  return truncateCodePoints(normalizeMemoryContentWhitespace(value), MEMORY_CONSTANTS.writeAndExtraction.contentMaxCodePoints).trim();
}

/** Evidence shares the same whitespace cleanup without truncating away a fabricated suffix. */
export function normalizeMemoryContentWhitespace(value: string): string {
  const collapsed = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '\n' || character === '\r' || character === '\t') return ' ';
    return codePoint < 0x20 || codePoint === 0x7f ? '' : character;
  }).join('').trim().replace(/\s+/gu, ' ');
  return collapsed;
}

export function sanitizeMemoryTopic(value: string): string {
  return truncateCodePoints(
    sanitizeMemoryContent(value),
    MEMORY_CONSTANTS.writeAndExtraction.topicMaxCodePoints,
  ).trim();
}

export function normalizeTopicKey(topic: string): string {
  let key = '';
  for (const character of sanitizeMemoryTopic(topic).toLocaleLowerCase('en-US')) {
    if (topicNoiseRunes.has(character)) continue;
    if (isLetterOrDigit(character) || isHan(character)) key += character;
  }
  for (const suffix of topicNoiseSuffixes) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      key = key.slice(0, -suffix.length);
      break;
    }
  }
  return truncateCodePoints(key, MEMORY_CONSTANTS.writeAndExtraction.topicNormalizedKeyMaxCodePoints);
}

export function normalizeMemoryKey(key: string, content: string): string {
  const candidate = (key.trim() || content).toLocaleLowerCase('en-US');
  const tokens: string[] = [];
  let latinToken = '';
  const flush = () => {
    if (!latinToken) return;
    tokens.push(latinToken);
    latinToken = '';
  };
  for (const character of candidate) {
    if (isHan(character)) {
      flush();
      tokens.push(character);
    } else if (isLetterOrDigit(character)) {
      latinToken += character;
    } else {
      flush();
    }
  }
  flush();
  return truncateCodePoints(
    [...new Set(tokens)].sort((left, right) => left.localeCompare(right, 'en-US')).join('-'),
    MEMORY_CONSTANTS.writeAndExtraction.memoryNormalizedKeyMaxCodePoints,
  );
}

export function memoryItemKey(topic: string, content: string): string {
  return normalizeTopicKey(topic) || normalizeMemoryKey(topic, content);
}

export function redactSensitiveMemoryContent(content: string): { content: string; redacted: boolean } {
  let redacted = content;
  for (const pattern of sensitivePatterns) {
    redacted = redacted.replace(pattern, REDACTED_MEMORY_PLACEHOLDER);
  }
  return { content: redacted, redacted: redacted !== content };
}

/** WEKNORA_PARITY_HARDENING: only redacted content must meet the retained-text threshold. */
export function isMostlyRedacted(content: string): boolean {
  if (!content.includes(REDACTED_MEMORY_PLACEHOLDER)) return false;
  const retained = sanitizeMemoryContent(content.replaceAll(REDACTED_MEMORY_PLACEHOLDER, ''));
  return Array.from(retained).length < MEMORY_CONSTANTS.writeAndExtraction.redactedContentMinCodePoints;
}

export function normalizeMemoryForMatch(content: string): string {
  let normalized = '';
  for (const character of sanitizeMemoryContent(content).toLocaleLowerCase('en-US')) {
    if (isLetterOrDigit(character)) normalized += character;
  }
  return normalized;
}

export function memoryFingerprint(content: string): string {
  const normalized = normalizeMemoryForMatch(content);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}

export function detectExplicitMemoryStatement(userText: string): string | undefined {
  const match = explicitPrefixPattern.exec(userText) ?? explicitEnglishPrefixPattern.exec(userText);
  if (!match?.[1]) return undefined;
  if (/^(?:了吗|了么|没有|吗|么)[？?！!。\s]*$/u.test(match[1].trim()) || /[？?]\s*$/u.test(userText)) return undefined;
  const statement = sanitizeMemoryContent(match[1]);
  return Array.from(statement).length >= MEMORY_CONSTANTS.writeAndExtraction.explicitStatementMinCodePoints
    ? statement
    : undefined;
}

export function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function isLetterOrDigit(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function isHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}
