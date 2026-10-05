export interface CodeLanguageOption {
  value: string;
  label: string;
}

export const CODE_LANGUAGE_OPTIONS: CodeLanguageOption[] = [
  { value: 'plaintext', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Bash' },
  { value: 'sql', label: 'SQL' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'xml', label: 'XML' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'mermaid', label: 'Mermaid' },
];

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  '': 'plaintext',
  c: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  txt: 'plaintext',
  yml: 'yaml',
};

export function normalizeCodeLanguage(value: string | null | undefined): string {
  const normalized = value?.trim().toLocaleLowerCase('en-US') ?? '';
  return CODE_LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function toCodeBlockLanguage(value: string | null | undefined): string | null {
  const normalized = normalizeCodeLanguage(value);
  return normalized === 'plaintext' ? null : normalized || null;
}

export const CODE_LANGUAGE_ICON_MARKS: Record<string, string> = {
  plaintext: 'Aa',
  javascript: 'JS',
  typescript: 'TS',
  python: '🐍',
  java: '☕',
  json: '{}',
  bash: '>_',
  sql: 'DB',
  html: 'HTML',
  css: '#',
  markdown: 'M↓',
  yaml: 'YAML',
  xml: 'XML',
  go: 'GO',
  rust: '⚙',
  csharp: 'C#',
  cpp: 'C++',
  mermaid: '◇',
};
