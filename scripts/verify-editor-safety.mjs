import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const rootDir = process.cwd();
const appPath = path.join(rootDir, 'src', 'App.tsx');
const appSource = fs.readFileSync(appPath, 'utf8');
const editorSource = fs.readFileSync(path.join(rootDir, 'src', 'components', 'Editor.tsx'), 'utf8');
const codeBlockExtensionSource = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'markdownCodeBlock.ts'), 'utf8');
const codeBlockNodeViewSource = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'CodeBlockNodeView.tsx'), 'utf8');
const codeBlockShortcutSource = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'codeBlockShortcuts.ts'), 'utf8');
const knowledgePanelSource = fs.readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
const themeSource = fs.readFileSync(path.join(rootDir, 'src', 'styles', 'variables.css'), 'utf8');
const contentSyncSource = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'contentSync.ts'), 'utf8');
const fineGrainedHistorySource = fs.readFileSync(path.join(rootDir, 'src', 'editor', 'fineGrainedHistory.ts'), 'utf8');

function requirePattern(pattern, message) {
  assert.match(appSource, pattern, message);
}

function requireBlockPattern(startPattern, endPattern, pattern, message) {
  const start = appSource.search(startPattern);
  assert.notEqual(start, -1, `Missing block start: ${startPattern}`);
  const rest = appSource.slice(start);
  const end = rest.search(endPattern);
  assert.notEqual(end, -1, `Missing block end: ${endPattern}`);
  assert.match(rest.slice(0, end), pattern, message);
}

requirePattern(/currentPathRef/, 'App must keep a currentPathRef for async save/UI guards.');
requirePattern(/new NoteSaveController/, 'App must use the versioned save controller.');
requirePattern(/selectionRequestIdRef/, 'App must guard async file selection races.');
requirePattern(/flushPendingSave/, 'App must expose a flushPendingSave path before navigation/destructive actions.');
requirePattern(
  /handleNavigateMainView\s*=\s*useCallback\(async\s*\(nextView:\s*MainView\)[\s\S]*?nextView\s*!==\s*['"]sources['"][\s\S]*?await\s+flushPendingSave\(\)[\s\S]*?setMainView\(nextView\)/,
  'Navigating to the materials view must flush pending note content before switching views.',
);
requirePattern(
  /<NavRail\b[^>]*onNavigate=\{\(view\)\s*=>\s*void\s+(?:handleNavigateMainView|navigateDuringGuide)\(view\)\}/,
  'NavRail navigation must use the guarded main-view navigation path.',
);
requirePattern(/const navigateDuringGuide[\s\S]*?await handleNavigateMainView\(view\)/, 'Guide navigation must delegate to the save-guarded path.');
requirePattern(
  /handleContentChange\s*=\s*useCallback\(\(\s*newContent:\s*string,\s*filePath:\s*string\s*\)/,
  'handleContentChange must receive the edited file path explicitly.',
);
requirePattern(
  /saveController\.snapshot\?\.path === path[\s\S]*?saveController\.edit\(nextContent/,
  'Edits must remain bound to the controller snapshot path.',
);
assert.doesNotMatch(
  appSource,
  /saveFile\(\s*currentPath\s*,\s*newContent\s*\)/,
  'Auto-save must not write via currentPath/newContent closure values.',
);

requireBlockPattern(/<Editor\b/, /\/>/, /key=\{currentPath\}/, 'Editor must be keyed by currentPath.');
requireBlockPattern(/<CodeMirror\b/, /\/>/, /key=\{currentPath\}/, 'CodeMirror must be keyed by currentPath.');
assert.match(editorSource, /newGroupDelay:\s*0/, 'Rich-text undo must create fine-grained history groups.');
assert.match(contentSyncSource, /setMeta\(['"]addToHistory['"],\s*false\)/, 'External content replacement must not enter undo history.');
assert.doesNotMatch(editorSource, /editor\.commands\.setContent\(editorHtml/, 'External synchronization must not replace content through a history-producing setContent command.');
assert.match(fineGrainedHistorySource, /closeHistory\(newState\.tr\)/, 'Each completed edit must close its undo history group.');
assert.match(fineGrainedHistorySource, /getMeta\(['"]addToHistory['"]\)\s*!==\s*false/, 'Non-history synchronization transactions must not create undo boundaries.');
assert.match(appSource, /showLineNumbers=\{isCurrentNoteAssistantOpen\s*&&\s*!focusActive\}/, 'The WYSIWYG gutter must follow the current-note AI assistant visibility.');
assert.match(knowledgePanelSource, /onAssistantVisibilityChange\?\.\(!isCollapsed\s*&&\s*activeTab\s*===\s*['"]ai['"]\)/, 'The right panel must report AI-tab visibility and collapse state.');
assert.match(editorSource, /getMarkdownLineAnchors\(content\)/, 'The gutter must use Markdown source positions instead of visual-wrap guesses.');
assert.match(editorSource, /seenLines\.has\(anchor\.line\)/, 'Only the first rendered anchor may be shown when several nodes share one source line.');
assert.match(themeSource, /\.editor-line-number-layer\s*\{/, 'The editor must provide a dedicated non-interactive line-number gutter.');
assert.match(
  themeSource,
  /\.editor-mode-bar\s*\{[^}]*flex:\s*0\s+0\s+42px;[^}]*min-height:\s*42px;/,
  'The editor mode tabs must keep their full height instead of shrinking out of view.',
);
assert.match(
  themeSource,
  /\.preview-container\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*min-height:\s*0;[^}]*height:\s*auto;/,
  'The preview must consume the remaining editor height without competing with the mode tabs.',
);
assert.match(
  editorSource,
  /className="editor-wrapper"[\s\S]*?flex:\s*['"]1 1 0['"][\s\S]*?minHeight:\s*0[\s\S]*?overflow:\s*['"]hidden['"]/,
  'The rich-text editor must be a shrinkable remaining-height flex child.',
);
assert.doesNotMatch(
  editorSource,
  /className="editor-wrapper"[^>]*style=\{\{[^}]*height:\s*['"]100%['"]/,
  'The rich-text editor must not claim 100% height in addition to the mode tabs.',
);
assert.doesNotMatch(
  editorSource,
  /<input\s+autoFocus\s+aria-label=["']代码语言["']/,
  'Opening the code-language popover must not move focus from the editor into its input.',
);
assert.match(
  editorSource,
  /transformPastedHTML:\s*html\s*=>\s*normalizePastedCodeBlockLanguages\(/,
  'Pasted code blocks must restore or detect their language before ProseMirror parses the clipboard HTML.',
);
assert.match(codeBlockExtensionSource, /ReactNodeViewRenderer\(CodeBlockNodeView/, 'Code blocks must install the shared node view so a language change can activate Mermaid rendering immediately.');
assert.match(codeBlockExtensionSource, /'Mod-a'/, 'Ctrl/Cmd+A inside a code block must be intercepted before the editor selects the whole note.');
assert.match(codeBlockExtensionSource, /TextSelection\.create\(this\.editor\.state\.doc, range\.from, range\.to\)/, 'Code-block select-all must select only the current code block text range.');
assert.match(codeBlockShortcutSource, /type\.name !== 'codeBlock'/, 'Code-block keyboard handling must detect the enclosing code block from the current editor selection.');
assert.match(codeBlockNodeViewSource, /securityLevel:\s*'strict'/, 'Editor Mermaid rendering must retain Mermaid strict security mode.');
assert.match(codeBlockNodeViewSource, /suppressErrorRendering:\s*true/, 'Editor Mermaid rendering must prevent Mermaid from appending global syntax-error diagrams.');
assert.match(codeBlockNodeViewSource, /mermaid\.parse\(source,\s*\{\s*suppressErrors:\s*true\s*\}\)/, 'Editor Mermaid syntax must be checked without invoking Mermaid global parse-error handling.');
assert.match(codeBlockNodeViewSource, /document\.body\.append\(renderHost\)/, 'Mermaid must receive an attached host so complex diagrams can measure their SVG layout.');
assert.match(codeBlockNodeViewSource, /renderHost\.remove\(\)/, 'The temporary Mermaid render host must be removed after every rendering attempt.');
assert.match(codeBlockNodeViewSource, /mermaid-editor-preview/, 'Mermaid code blocks must render a dedicated in-editor preview surface.');
assert.match(codeBlockNodeViewSource, /MermaidDiagramViewer/, 'Mermaid editor previews must provide a full-detail dialog.');
assert.match(codeBlockNodeViewSource, /window\.setTimeout\([\s\S]*?220/, 'Rapid Mermaid edits must be debounced before rendering.');
assert.match(codeBlockNodeViewSource, /fitMermaidSvgToPreview/, 'Editor Mermaid diagrams must fit both the bounded preview height and current editor width.');
assert.match(codeBlockNodeViewSource, /new ResizeObserver\(refitDiagram\)/, 'Editor Mermaid diagrams must refit when their container size changes.');
assert.match(themeSource, /\.ProseMirror \.mermaid-editor-preview\s*\{[^}]*max-height:\s*clamp\(220px, 46vh, 460px\);[^}]*overflow:\s*auto;/, 'Editor Mermaid previews must be height-bounded and scroll locally.');

// Exercise the production controller: switching drafts, concurrent saves, conflicts and close.
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'verify-note-save-controller.mjs')], { stdio: 'inherit' });

console.log('Editor safety verification passed');
