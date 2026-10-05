import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { Alert, Button, Group, Menu, Text } from '@mantine/core';
import { MoreHorizontal, Sparkles } from 'lucide-react';
import type { EditorPreferences } from '../../shared/editorPreferences';
import { hasDocumentLocalReferences } from '../../shared/documentResources';
import { EXTERNAL_MARKDOWN_RENDER_MAX_BYTES } from '../../shared/documentSession';
import type { HeadingEntry, LibrarySummary } from '../electron';
import type { ResolvedTheme } from '../utils/theme';
import type { useExternalDocuments } from '../hooks/useExternalDocuments';
import { useTypewriterScroll } from '../hooks/useTypewriterScroll';
import { getMarkdownLineAnchors } from '../utils/markdown';
import { createHeadingAnchorIds } from '../utils/headingAnchors';
import { getNoteViewportRect } from '../editor/editorCoordinates';
import Editor from './Editor';
import MarkdownPreview from './MarkdownPreview';
import EditorWordCount from './EditorWordCount';
import EditorZoomControl from './EditorZoomControl';
import ExternalDocumentAiPanel from './ExternalDocumentAiPanel';
import { getClipboardImageSources, getDroppedImageSources, type ClipboardImageSource } from '../utils/editorImageClipboard';
import type { DocumentResourcePreview } from '../../shared/documentSession';
import { t } from '../i18n';
import './ExternalDocumentWorkspace.css';

interface Props { documents: ReturnType<typeof useExternalDocuments>; libraries: LibrarySummary[]; preferences: EditorPreferences; theme: ResolvedTheme; documentStyle: CSSProperties; active: boolean; blocked: boolean; zoom: number; onZoom: (zoom: number) => void; onReturnLibrary: () => void }
/** 复用原有编辑组件，独立文件不注入当前库的图片、AI 或索引上下文。 */
export default function ExternalDocumentWorkspace({ documents, libraries, preferences, theme, documentStyle, active, blocked, zoom, onZoom, onReturnLibrary }: Props) {
  const { controller } = documents, snapshot = controller.snapshot!;
  const [mode, setMode] = useState<'source' | 'preview' | 'wysiwyg'>('source');
  const [headings, setHeadings] = useState<HeadingEntry[]>([]), [jump, setJump] = useState<{ heading: HeadingEntry; nonce: number } | null>(null);
  const sourceRef = useRef<ReactCodeMirrorRef>(null);
  const [resources, setResources] = useState<DocumentResourcePreview>({ urls: {}, issues: [], draftRevision: -1 }), [resourceRefresh, setResourceRefresh] = useState(0), [aiOpened, setAiOpened] = useState(false);
  useEffect(() => {
    let current = true; const timer = setTimeout(() => { void (async () => { await controller.synchronize(); const result = await window.electronAPI.previewDocumentResources(snapshot.documentSessionId); if (current) setResources(result); })().catch(error => { if (current) setResources({ urls: {}, issues: [String(error)], draftRevision: controller.revision }); }); }, 350);
    return () => { current = false; clearTimeout(timer); };
  }, [snapshot.documentSessionId, snapshot.displayPath, controller, controller.content, resourceRefresh]);
  const saveImage = async (source: ClipboardImageSource) => {
    const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
    const input = source.kind === 'local-path' ? { sourcePath: source.sourcePath } : { bytes: new Uint8Array(await source.file.arrayBuffer()), extension: extensions[source.file.type] ?? `.${source.file.name.split('.').at(-1)?.toLowerCase()}` };
    return window.electronAPI.addDocumentImage(snapshot.documentSessionId, input);
  };
  const insertImages = async (sources: ClipboardImageSource[]) => {
    const view = sourceRef.current?.view, revision = controller.revision, id = snapshot.documentSessionId; if (!view || documents.editingBlocked || blocked) return;
    const selection = view.state.selection.main;
    try { const images = []; for (const source of sources) images.push(await saveImage(source));
      if (sourceRef.current?.view !== view || controller.revision !== revision || controller.snapshot?.documentSessionId !== id || !view.state.selection.main.eq(selection)) throw new Error(t('文档或选区已变化，请重新粘贴图片。'));
      view.dispatch(view.state.replaceSelection(images.map(image => `![${image.fileName}](${image.markdownPath})`).join('\n')));
    } catch (error) { window.alert(String(error)); }
  };
  const getSelection = () => { const view = sourceRef.current?.view; if (mode !== 'source' || !view || view.state.selection.main.empty) return undefined; const { from, to } = view.state.selection.main; return { from, to, text: view.state.sliceDoc(from, to) }; };
  const isMarkdown = snapshot.fileKind === 'markdown';
  const local = useMemo(() => isMarkdown && hasDocumentLocalReferences(controller.content), [isMarkdown, controller.content]);
  const renderAllowed = isMarkdown && new TextEncoder().encode(controller.content).length <= EXTERNAL_MARKDOWN_RENDER_MAX_BYTES;
  const richAllowed = renderAllowed && !local, disabled = documents.busy || blocked;
  const sourceHeadings = useMemo(() => {
    if (!isMarkdown || !renderAllowed) return [];
    const lines = controller.content.split('\n'), anchors = getMarkdownLineAnchors(controller.content).filter(anchor => anchor.kind === 'heading');
    const ids = createHeadingAnchorIds(anchors.map(anchor => anchor.text));
    return anchors.map((anchor, index) => ({ id: ids[index], text: anchor.text, line: anchor.line, index, level: (lines[anchor.line - 1]?.match(/^\s{0,3}(#{1,6})\s/)?.[1].length ?? (lines[anchor.line]?.trim().startsWith('=') ? 1 : 2)) as HeadingEntry['level'] }));
  }, [controller.content, isMarkdown, renderAllowed]);
  const outline = mode === 'source' ? sourceHeadings : headings;
  useEffect(() => { setMode('source'); setHeadings([]); }, [snapshot.documentSessionId]);
  useEffect(() => { if ((mode === 'wysiwyg' && !richAllowed) || (mode === 'preview' && !renderAllowed) || (!isMarkdown && mode !== 'source')) setMode('source'); }, [mode, richAllowed, isMarkdown, renderAllowed]);
  const extensions = useMemo(() => [EditorView.lineWrapping, ...(isMarkdown ? [markdown()] : [])], [isMarkdown]);
  useEffect(() => { if (jump && mode === 'source') { const view = sourceRef.current?.view; if (view) { const pos = view.state.doc.line(Math.min(jump.heading.line, view.state.doc.lines)).from; view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); } } }, [jump, mode]);
  const getTarget = () => { const view = sourceRef.current?.view; if (!view || documents.editingBlocked || blocked) return null; const caret = view.coordsAtPos(view.state.selection.main.head); return { scroller: view.scrollDOM, content: view.contentDOM, collapsed: view.state.selection.main.empty, caret: caret ? getNoteViewportRect(caret, view.contentDOM) : null, requestMeasure: () => view.requestMeasure() }; };
  useTypewriterScroll({ enabled: preferences.editorTypewriterModeEnabled, active: active && mode === 'source', getTarget, layoutKey: `${snapshot.documentSessionId}:${zoom}:${preferences.editorFontSizePx}:${preferences.editorContentWidth}`, navigationKey: `${jump?.nonce}`, zoom });
  return <main className="main-pane external-document" data-document-session={snapshot.documentSessionId} data-document-busy={documents.busy || undefined}>
    <div className="workspace"><div className="editor-pane note-document-surface" style={documentStyle}>
      <div className="external-document-header"><div className="external-document-name"><Text fw={600} size="sm">{snapshot.displayPath.split(/[\\/]/).at(-1)}</Text><Text c="dimmed" size="xs" title={snapshot.displayPath}>{snapshot.displayPath}</Text></div>
        <Group gap={6} wrap="nowrap">{documents.pendingFiles.length > 0 && <Button size="compact-xs" variant="subtle" onClick={documents.showPendingFiles}>{t('待打开文件')} ({documents.pendingFiles.length})</Button>}<Button size="compact-xs" variant="default" disabled={disabled || !snapshot.capabilities.canSaveInPlace} onClick={() => void documents.save()}>{t('保存')}</Button><Button size="compact-xs" variant="default" disabled={disabled} onClick={() => void documents.save('saveAs')}>{t('另存为')}</Button><Button size="compact-xs" disabled={disabled} onClick={() => void documents.join(libraries)}>{t('加入笔记库')}</Button><Button size="compact-xs" variant="subtle" aria-label={t('当前文档 AI')} onClick={() => setAiOpened(value => !value)}><Sparkles size={14} /></Button>
          <Menu position="bottom-end"><Menu.Target><Button size="compact-xs" variant="subtle" aria-label={t('文件操作')} disabled={disabled}><MoreHorizontal size={16} /></Button></Menu.Target><Menu.Dropdown><Menu.Item onClick={() => { void window.electronAPI.grantDocumentResourceRoot(snapshot.documentSessionId).then(() => setResourceRefresh(value => value + 1)).catch(error => window.alert(String(error))); }}>{t('选择资源目录')}</Menu.Item><Menu.Item onClick={() => void documents.reload(true)}>{t("以其他编码重新打开")}</Menu.Item><Menu.Item onClick={() => void documents.reload()}>{t('重新加载')}</Menu.Item><Menu.Item onClick={() => void documents.save('saveAs', true)}>{t('以 UTF-8 另存')}</Menu.Item><Menu.Item onClick={() => void documents.recover()}>{t('恢复独立文件草稿')}</Menu.Item><Menu.Divider /><Menu.Item onClick={onReturnLibrary}>{t('返回笔记库')}</Menu.Item></Menu.Dropdown></Menu>
        </Group></div>
      <div className="editor-mode-bar"><div className="segmented-control"><button className={mode === 'wysiwyg' ? 'active' : ''} disabled={!richAllowed || disabled} onClick={() => setMode('wysiwyg')}>{t('编辑')}</button><button className={mode === 'preview' ? 'active' : ''} disabled={!renderAllowed || disabled} onClick={() => setMode('preview')}>{t('预览')}</button><button className={mode === 'source' ? 'active' : ''} disabled={disabled} onClick={() => setMode('source')}>{t('源码')}</button></div><span className="external-format">{t('独立文件')} · {snapshot.format.encoding.toUpperCase()} {snapshot.format.bom !== 'none' ? 'BOM' : ''} · {snapshot.format.lineEnding.toUpperCase()}</span><div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}><EditorWordCount content={controller.content} isMarkdown={isMarkdown} /><EditorZoomControl value={zoom} defaultValue={preferences.defaultEditorZoom} onChange={onZoom} /></div></div>
      <div className="external-save-notice" data-status={controller.status} role="status"><span>{controller.message ?? t(controller.status === 'saving' ? '正在保存…' : controller.status === 'clean' ? '已保存' : '有未保存修改')}</span>{controller.message && <Button size="compact-xs" variant="subtle" disabled={disabled} onClick={() => void documents.save()}>{t('重试')}</Button>}</div>
      {controller.recoveryMessage && <Alert color="yellow" role="status"><Group justify="space-between"><Text size="xs" style={{ whiteSpace: 'pre-line' }}>{controller.recoveryMessage.split('\n').map(message => t(message)).join('\n')}</Text><Button size="compact-xs" variant="subtle" disabled={disabled} onClick={() => { void controller.synchronize().catch(() => undefined); }}>{t('重试恢复缓存')}</Button></Group></Alert>}
      {resources.issues.length > 0 && <div className="external-resource-notice" role="status">{t('部分资源未加载，可在文件操作中选择资源目录。')}<details><summary>{t('查看资源问题')}</summary>{resources.issues.map((issue, i) => <div key={i}>{issue}</div>)}</details></div>}
      {/\[\[[^\]]+\]\]/.test(controller.content) && <div className="external-resource-notice">{t('跨文件 Wiki 链接加入笔记库后使用。')}</div>}
      {mode === 'source' && <div className="source-editor-zoom" style={{ zoom }}><CodeMirror ref={sourceRef} className="source-editor" value={controller.content} editable={!documents.editingBlocked && !blocked} height="100%" theme={theme} extensions={extensions} basicSetup={{ lineNumbers: true, foldGutter: true }} onChange={value => controller.edit(value)} onPaste={event => { const sources = isMarkdown ? getClipboardImageSources(event.clipboardData) : []; if (sources.length) { event.preventDefault(); void insertImages(sources); } }} onDrop={event => { const sources = isMarkdown && !Array.from(event.dataTransfer.files).some(file => !file.type.startsWith('image/')) ? getDroppedImageSources(event.dataTransfer) : []; if (sources.length) { event.preventDefault(); event.stopPropagation(); void insertImages(sources); } }} /></div>}
      {mode === 'preview' && <MarkdownPreview content={controller.content} currentPath={snapshot.displayPath} zoom={zoom} frontmatter="preserve" disableApplicationLinks disableLocalResources externalAssetUrls={resources.draftRevision === controller.revision ? resources.urls : {}} onOpenRelativeMarkdownLink={target => { void window.electronAPI.openDocumentLink(snapshot.documentSessionId, target.path).catch(error => window.alert(String(error))); }} resolvedTheme={theme} showCodeCopyActions headingJump={jump} onOutlineChange={setHeadings} />}
      {mode === 'wysiwyg' && richAllowed && <Editor allowDocumentAi={false} content={controller.content} preferences={preferences} currentPath={snapshot.displayPath} zoom={zoom} active={active} isInteractionBlocked={documents.editingBlocked || blocked} readOnly={documents.editingBlocked || blocked} onChange={value => controller.edit(value)} onOutlineChange={setHeadings} headingJump={jump} onOpenWikiLink={() => undefined} onSaveImage={async () => { throw new Error(t('请切换源码模式后粘贴或拖入图片。')); }} />}
    </div>{aiOpened ? <aside className="external-ai-sidebar"><ExternalDocumentAiPanel key={snapshot.documentSessionId} documents={documents} getSelection={getSelection} libraries={libraries} blocked={blocked} /></aside> : isMarkdown && outline.length > 0 && <aside className="external-outline" aria-label={t('目录')}>{outline.map((heading, i) => <button key={i} style={{ paddingLeft: 8 + heading.level * 8 }} onClick={() => setJump({ heading, nonce: Date.now() })}>{heading.text}</button>)}</aside>}</div>
  </main>;
}
