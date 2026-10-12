import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { Alert, Button, Group, Menu, Text } from '@mantine/core';
import { Bot, MoreHorizontal } from 'lucide-react';
import type { EditorPreferences } from '../../shared/editorPreferences';
import { hasDocumentLocalReferences } from '../../shared/documentResources';
import { EXTERNAL_MARKDOWN_RENDER_MAX_BYTES } from '../../shared/documentSession';
import type { HeadingEntry, LibrarySummary } from '../electron';
import type { ResolvedTheme } from '../utils/theme';
import type { useExternalDocuments } from '../hooks/useExternalDocuments';
import { useTypewriterScroll } from '../hooks/useTypewriterScroll';
import { getMarkdownLineAnchors } from '../utils/markdown';
import { createHeadingAnchorIds } from '../utils/headingAnchors';
import { scheduleAfterPaint } from '../utils/afterPaint';
import { getNoteViewportRect } from '../editor/editorCoordinates';
import Editor from './Editor';
import MarkdownPreview from './MarkdownPreview';
import EditorWordCount from './EditorWordCount';
import EditorZoomControl from './EditorZoomControl';
import ExternalDocumentAssistant from './ExternalDocumentAssistant';
import type { KnowledgeAssistantProps } from './KnowledgePanel';
import { getClipboardImageSources, getDroppedImageSources, type ClipboardImageSource } from '../utils/editorImageClipboard';
import type { DocumentResourcePreview } from '../../shared/documentSession';
import { t } from '../i18n';
import './ExternalDocumentWorkspace.css';

interface Props { documents: ReturnType<typeof useExternalDocuments>; libraries: LibrarySummary[]; assistant: KnowledgeAssistantProps; preferences: EditorPreferences; theme: ResolvedTheme; documentStyle: CSSProperties; active: boolean; blocked: boolean; zoom: number; onZoom: (zoom: number) => void; onReturnLibrary: () => void }
interface DisplayKey { id: string; path: string; revision: number; content: string }
interface OutlineResult { key: DisplayKey; retry: number; state: 'loading' | 'ready' | 'error'; headings: HeadingEntry[]; hasHeadings: boolean }
interface ResourceResult { key: DisplayKey; refresh: number; state: 'ready' | 'error'; preview: DocumentResourcePreview }
const EMPTY_RESOURCE_URLS: Record<string, string> = {};
/** 同一修订号也可能来自不同会话；所有后台展示结果都核对会话、路径和正文。 */
function sameDisplayKey(left: DisplayKey | undefined, right: DisplayKey): boolean { return Boolean(left && left.id === right.id && left.path === right.path && left.revision === right.revision && left.content === right.content); }
/** 独立文件保持自己的编辑会话，侧栏助手只读取当前文件草稿。 */
export default function ExternalDocumentWorkspace({ documents, libraries, assistant, preferences, theme, documentStyle, active, blocked, zoom, onZoom, onReturnLibrary }: Props) {
  const { controller } = documents, snapshot = controller.snapshot!;
  const [mode, setMode] = useState<'source' | 'preview' | 'wysiwyg'>('preview');
  const [headings, setHeadings] = useState<HeadingEntry[]>([]), [jump, setJump] = useState<{ heading: HeadingEntry; nonce: number } | null>(null);
  const sourceRef = useRef<ReactCodeMirrorRef>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [outlineWidth, setOutlineWidth] = useState(190), [outlineResizing, setOutlineResizing] = useState(false);
  const outlineDrag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [resourceResult, setResourceResult] = useState<ResourceResult>(), [resourceRefresh, setResourceRefresh] = useState(0), [aiOpened, setAiOpened] = useState(false);
  const [aiMounted, setAiMounted] = useState(false);
  const [sourceOutline, setSourceOutline] = useState<OutlineResult>(), [previewOutline, setPreviewOutline] = useState<OutlineResult>(), [outlineRetry, setOutlineRetry] = useState(0);
  const displayKey = useMemo(() => ({ id: snapshot.documentSessionId, path: snapshot.displayPath, revision: controller.revision, content: controller.content }), [snapshot.documentSessionId, snapshot.displayPath, controller.revision, controller.content]);
  const isMarkdown = snapshot.fileKind === 'markdown';
  // 所有文本按内容提供 Markdown 视图；本地引用和大文件继续用源码编辑，避免富文本转换损坏引用。
  // 保存期间仍可输入时，渲染侧快照可能含较新的草稿；只复用已提交正文的主进程能力。
  const snapshotCapabilitiesCurrent = controller.content === snapshot.content && controller.revision === snapshot.persistedRevision;
  const renderAllowed = useMemo(() => snapshotCapabilitiesCurrent ? snapshot.capabilities.canPreviewMarkdown : new TextEncoder().encode(controller.content).length <= EXTERNAL_MARKDOWN_RENDER_MAX_BYTES, [controller.content, snapshotCapabilitiesCurrent, snapshot.capabilities.canPreviewMarkdown]);
  const local = useMemo(() => renderAllowed && (snapshotCapabilitiesCurrent ? !snapshot.capabilities.canUseWysiwyg : hasDocumentLocalReferences(controller.content)), [controller.content, snapshotCapabilitiesCurrent, snapshot.capabilities.canUseWysiwyg, renderAllowed]);
  const richAllowed = renderAllowed && !local, disabled = documents.busy || blocked;
  const sourceEditing = mode === 'source' || (mode === 'wysiwyg' && !richAllowed);
  const resources = sameDisplayKey(resourceResult?.key, displayKey) ? resourceResult!.preview : undefined;
  const resourceSettled = Boolean(resources && resourceResult?.refresh === resourceRefresh);
  const resourceState = !renderAllowed || !local ? 'skipped' : !active || mode !== 'preview' ? 'pending' : resourceResult?.refresh === resourceRefresh && resources ? resourceResult.state : 'loading';
  const isDisplayCurrent = useCallback(() => sameDisplayKey({ id: controller.snapshot?.documentSessionId ?? '', path: controller.snapshot?.displayPath ?? '', revision: controller.revision, content: controller.content }, displayKey), [controller, displayKey]);
  useEffect(() => {
    if (!renderAllowed || !local || !active || mode !== 'preview' || resourceSettled) return;
    let current = true; let deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (!current || !isDisplayCurrent()) return;
      current = false;
      setResourceResult(previous => ({ key: displayKey, refresh: resourceRefresh, state: 'error', preview: { urls: sameDisplayKey(previous?.key, displayKey) ? previous!.preview.urls : EMPTY_RESOURCE_URLS, issues: [message], draftRevision: displayKey.revision } }));
    };
    // 只有预览中确有本地引用时才请求授权；超时结束等待，迟到结果不能写入新文档。
    const cancel = scheduleAfterPaint(() => {
      deadline = setTimeout(() => fail(t('资源加载超时，可重试或选择资源目录。')), 15_000);
      void (async () => {
        if (!isDisplayCurrent()) return;
        await controller.synchronize();
        if (!current || !isDisplayCurrent()) return;
        const preview = await window.electronAPI.previewDocumentResources(displayKey.id);
        if (!current || !isDisplayCurrent()) return;
        if (preview.draftRevision !== displayKey.revision) { fail(t('文档资源版本已变化，请重试。')); return; }
        setResourceResult({ key: displayKey, refresh: resourceRefresh, state: preview.issues.length ? 'error' : 'ready', preview });
      })().catch(error => fail(String(error))).finally(() => clearTimeout(deadline));
    }, 350);
    return () => { current = false; cancel(); clearTimeout(deadline); };
  }, [displayKey, controller, resourceRefresh, renderAllowed, local, active, mode, resourceSettled, isDisplayCurrent]);
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
  // 首次打开后保留助手实例；收起侧栏不会丢失问题草稿或中断正在生成的回答。
  const toggleAssistant = () => { setAiMounted(true); setAiOpened(value => !value); };
  const sourceResult = sameDisplayKey(sourceOutline?.key, displayKey) && sourceOutline?.retry === outlineRetry ? sourceOutline : undefined;
  const previewResult = sameDisplayKey(previewOutline?.key, displayKey) && previewOutline?.retry === outlineRetry ? previewOutline : undefined;
  useEffect(() => {
    if (!active || !sourceEditing || !renderAllowed || sourceResult) return;
    // 源码行锚点仅在用户打开源码时生成；预览目录直接读取已经渲染的标题。
    return scheduleAfterPaint(() => {
      if (!isDisplayCurrent()) return;
      try {
        const lines = displayKey.content.split('\n'), anchors = getMarkdownLineAnchors(displayKey.content).filter(anchor => anchor.kind === 'heading');
        const ids = createHeadingAnchorIds(anchors.map(anchor => anchor.text));
        const entries = anchors.map((anchor, index) => ({ id: ids[index], text: anchor.text, line: anchor.line, index, level: (lines[anchor.line - 1]?.match(/^\s{0,3}(#{1,6})\s/)?.[1].length ?? (lines[anchor.line]?.trim().startsWith('=') ? 1 : 2)) as HeadingEntry['level'] }));
        setSourceOutline({ key: displayKey, retry: outlineRetry, state: 'ready', headings: entries, hasHeadings: entries.length > 0 });
      } catch { setSourceOutline({ key: displayKey, retry: outlineRetry, state: 'error', headings: [], hasHeadings: false }); }
    });
  }, [active, sourceEditing, renderAllowed, sourceResult, displayKey, outlineRetry, isDisplayCurrent]);
  const onPreviewOutlinePending = useCallback((hasHeadings: boolean) => { if (isDisplayCurrent()) setPreviewOutline({ key: displayKey, retry: outlineRetry, state: 'loading', headings: [], hasHeadings }); }, [displayKey, outlineRetry, isDisplayCurrent]);
  const onPreviewOutline = useCallback((entries: HeadingEntry[]) => { if (isDisplayCurrent()) setPreviewOutline({ key: displayKey, retry: outlineRetry, state: 'ready', headings: entries, hasHeadings: entries.length > 0 }); }, [displayKey, outlineRetry, isDisplayCurrent]);
  const onPreviewOutlineError = useCallback(() => { if (isDisplayCurrent()) setPreviewOutline({ key: displayKey, retry: outlineRetry, state: 'error', headings: [], hasHeadings: false }); }, [displayKey, outlineRetry, isDisplayCurrent]);
  const outlineState = !renderAllowed ? 'skipped' : mode === 'wysiwyg' && richAllowed ? 'ready' : (sourceEditing ? sourceResult : previewResult)?.state ?? 'loading';
  const outline = !renderAllowed ? [] : sourceEditing ? sourceResult?.headings ?? [] : mode === 'preview' ? previewResult?.headings ?? [] : headings;
  const showOutline = outline.length > 0 || (outlineState === 'loading' && (previewOutline?.key.id === displayKey.id && previewOutline.hasHeadings || sourceEditing && sourceOutline?.key.id === displayKey.id && sourceOutline.hasHeadings));
  // 目录只占工作区的一部分；指针捕获让拖动离开分隔线后仍可继续和正常结束。
  const constrainOutlineWidth = (width: number) => Math.max(160, Math.min(480, (workspaceRef.current?.clientWidth ?? window.innerWidth) / 2, width));
  const startOutlineResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    outlineDrag.current = { pointerId: event.pointerId, x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width };
    setOutlineResizing(true);
  };
  const moveOutlineResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = outlineDrag.current;
    if (drag?.pointerId === event.pointerId) setOutlineWidth(constrainOutlineWidth(drag.width + drag.x - event.clientX));
  };
  const finishOutlineResize = () => { outlineDrag.current = null; setOutlineResizing(false); };
  useEffect(() => {
    if (!outlineResizing) return;
    const cancelResize = () => { outlineDrag.current = null; setOutlineResizing(false); };
    document.body.classList.add('resizing-external-outline');
    window.addEventListener('blur', cancelResize);
    return () => { document.body.classList.remove('resizing-external-outline'); window.removeEventListener('blur', cancelResize); };
  }, [outlineResizing]);
  useEffect(() => { outlineDrag.current = null; setOutlineResizing(false); }, [aiOpened, snapshot.documentSessionId, outline.length, active]);
  // 先清理旧文档状态，再由预览组件的 effect 上报新目录，避免首次打开时覆盖目录。
  useLayoutEffect(() => { setMode('preview'); setHeadings([]); setJump(null); }, [snapshot.documentSessionId]);
  const extensions = useMemo(() => [EditorView.lineWrapping, ...(isMarkdown ? [markdown()] : [])], [isMarkdown]);
  useEffect(() => { if (jump && sourceEditing) { const view = sourceRef.current?.view; if (view) { const pos = view.state.doc.line(Math.min(jump.heading.line, view.state.doc.lines)).from; view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); } } }, [jump, sourceEditing]);
  const getTarget = () => { const view = sourceRef.current?.view; if (!view || documents.editingBlocked || blocked) return null; const caret = view.coordsAtPos(view.state.selection.main.head); return { scroller: view.scrollDOM, content: view.contentDOM, collapsed: view.state.selection.main.empty, caret: caret ? getNoteViewportRect(caret, view.contentDOM) : null, requestMeasure: () => view.requestMeasure() }; };
  useTypewriterScroll({ enabled: preferences.editorTypewriterModeEnabled, active: active && sourceEditing, getTarget, layoutKey: `${snapshot.documentSessionId}:${zoom}:${preferences.editorFontSizePx}:${preferences.editorContentWidth}`, navigationKey: `${jump?.nonce}`, zoom });
  return <main className="main-pane external-document" data-document-session={snapshot.documentSessionId} data-document-busy={documents.busy || undefined} data-document-outline-state={outlineState} data-document-resource-state={resourceState}>
    <div className="workspace" ref={workspaceRef}><div className="editor-pane note-document-surface" style={documentStyle}>
      <div className="external-document-header"><div className="external-document-name"><Text fw={600} size="sm">{snapshot.displayPath.split(/[\\/]/).at(-1)}</Text><Text c="dimmed" size="xs" title={snapshot.displayPath}>{snapshot.displayPath}</Text></div>
        <Group gap={6} wrap="nowrap">{documents.pendingFiles.length > 0 && <Button size="compact-xs" variant="subtle" onClick={documents.showPendingFiles}>{t('待打开文件')} ({documents.pendingFiles.length})</Button>}<Button size="compact-xs" variant="default" disabled={disabled || !snapshot.capabilities.canSaveInPlace} onClick={() => void documents.save()}>{t('保存')}</Button><Button size="compact-xs" variant="default" disabled={disabled} onClick={() => void documents.save('saveAs')}>{t('另存为')}</Button><Button size="compact-xs" disabled={disabled} onClick={() => void documents.join(libraries)}>{t('加入笔记库')}</Button><Button className="external-document-assistant-toggle" size="compact-xs" variant={aiOpened ? 'light' : 'default'} leftSection={<Bot size={15} />} aria-label={t('当前文件 AI 助手')} aria-expanded={aiOpened} aria-controls="external-document-assistant" onClick={toggleAssistant}>{t('AI 助手')}</Button>
          <Menu position="bottom-end"><Menu.Target><Button size="compact-xs" variant="subtle" aria-label={t('文件操作')} disabled={disabled}><MoreHorizontal size={16} /></Button></Menu.Target><Menu.Dropdown><Menu.Item onClick={() => { void window.electronAPI.grantDocumentResourceRoot(snapshot.documentSessionId).then(() => setResourceRefresh(value => value + 1)).catch(error => window.alert(String(error))); }}>{t('选择资源目录')}</Menu.Item><Menu.Item onClick={() => void documents.reload(true)}>{t("以其他编码重新打开")}</Menu.Item><Menu.Item onClick={() => void documents.reload()}>{t('重新加载')}</Menu.Item><Menu.Item onClick={() => void documents.save('saveAs', true)}>{t('以 UTF-8 另存')}</Menu.Item><Menu.Item onClick={() => void documents.recover()}>{t('恢复独立文件草稿')}</Menu.Item><Menu.Divider /><Menu.Item onClick={onReturnLibrary}>{t('返回笔记库')}</Menu.Item></Menu.Dropdown></Menu>
        </Group></div>
      <div className="editor-mode-bar"><div className="segmented-control"><button className={mode === 'wysiwyg' ? 'active' : ''} disabled={disabled} onClick={() => setMode('wysiwyg')}>{t('编辑')}</button><button className={mode === 'preview' ? 'active' : ''} disabled={disabled} onClick={() => setMode('preview')}>{t('预览')}</button><button className={mode === 'source' ? 'active' : ''} disabled={disabled} onClick={() => setMode('source')}>{t('源码')}</button></div><span className="external-format">{t('独立文件')} · {snapshot.format.encoding.toUpperCase()} {snapshot.format.bom !== 'none' ? 'BOM' : ''} · {snapshot.format.lineEnding.toUpperCase()}</span><div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}><EditorWordCount content={controller.content} isMarkdown={isMarkdown} active={active} /><EditorZoomControl value={zoom} defaultValue={preferences.defaultEditorZoom} onChange={onZoom} /></div></div>
      <div className="external-save-notice" data-status={controller.status} role="status"><span>{controller.message ?? t(controller.status === 'saving' ? '正在保存…' : controller.status === 'clean' ? '已保存' : '有未保存修改')}</span>{controller.message && <Button size="compact-xs" variant="subtle" disabled={disabled} onClick={() => void documents.save()}>{t('重试')}</Button>}
      {(outlineState === 'error' || resourceState === 'loading' || resourceState === 'error') && <div className="external-progress-notice" role="status">{outlineState === 'error' && <><span>{t('目录加载失败')}</span><Button size="compact-xs" variant="subtle" onClick={() => setOutlineRetry(value => value + 1)}>{t('重试目录')}</Button></>}{resourceState === 'loading' && <span>{t('资源正在加载…')}</span>}{resourceState === 'error' && <><Button size="compact-xs" variant="subtle" onClick={() => setResourceRefresh(value => value + 1)}>{t('重试资源')}</Button>{resources && resources.issues.length > 0 && <details className="external-resource-notice"><summary>{t('查看资源问题')}</summary><div className="external-resource-details">{t('部分资源未加载，可在文件操作中选择资源目录。')}{resources.issues.map((issue, i) => <div key={i}>{issue}</div>)}</div></details>}</>}</div>}
      </div>
      {controller.recoveryMessage && <Alert color="yellow" role="status"><Group justify="space-between"><Text size="xs" style={{ whiteSpace: 'pre-line' }}>{controller.recoveryMessage.split('\n').map(message => t(message)).join('\n')}</Text><Button size="compact-xs" variant="subtle" disabled={disabled} onClick={() => { void controller.synchronize().catch(() => undefined); }}>{t('重试恢复缓存')}</Button></Group></Alert>}
      {/\[\[[^\]]+\]\]/.test(controller.content) && <div className="external-resource-notice">{t('跨文件 Wiki 链接加入笔记库后使用。')}</div>}
      {sourceEditing && <div className="source-editor-zoom" style={{ zoom }}><CodeMirror ref={sourceRef} className="source-editor" value={controller.content} editable={!documents.editingBlocked && !blocked} height="100%" theme={theme} extensions={extensions} basicSetup={{ lineNumbers: true, foldGutter: true }} onChange={value => controller.edit(value)} onPaste={event => { const sources = isMarkdown ? getClipboardImageSources(event.clipboardData) : []; if (sources.length) { event.preventDefault(); void insertImages(sources); } }} onDrop={event => { const sources = isMarkdown && !Array.from(event.dataTransfer.files).some(file => !file.type.startsWith('image/')) ? getDroppedImageSources(event.dataTransfer) : []; if (sources.length) { event.preventDefault(); event.stopPropagation(); void insertImages(sources); } }} /></div>}
      {mode === 'preview' && (renderAllowed ? <MarkdownPreview content={controller.content} currentPath={snapshot.displayPath} zoom={zoom} frontmatter="preserve" disableApplicationLinks disableLocalResources externalAssetUrls={resources?.urls ?? EMPTY_RESOURCE_URLS} onOpenRelativeMarkdownLink={target => { void window.electronAPI.openDocumentLink(snapshot.documentSessionId, target.path).catch(error => window.alert(String(error))); }} resolvedTheme={theme} showCodeCopyActions headingJump={jump} deferOutline outlineRetry={outlineRetry} onOutlinePending={onPreviewOutlinePending} onOutlineChange={onPreviewOutline} onOutlineError={onPreviewOutlineError} /> : <div className="preview-container external-text-preview" style={{ zoom }}><pre>{controller.content}</pre></div>)}
      {mode === 'wysiwyg' && richAllowed && <Editor allowDocumentAi={false} content={controller.content} preferences={preferences} currentPath={snapshot.displayPath} zoom={zoom} active={active} isInteractionBlocked={documents.editingBlocked || blocked} readOnly={documents.editingBlocked || blocked} onChange={value => controller.edit(value)} onOutlineChange={setHeadings} headingJump={jump} onOpenWikiLink={() => undefined} onSaveImage={async () => { throw new Error(t('请切换源码模式后粘贴或拖入图片。')); }} />}
    </div>{aiMounted && <aside id="external-document-assistant" className="external-ai-sidebar" aria-label={t('当前文件 AI 助手')} hidden={!aiOpened}><ExternalDocumentAssistant key={snapshot.documentSessionId} assistant={assistant} controller={controller} blocked={blocked} onClose={() => setAiOpened(false)} onNavigateLine={line => { setMode('source'); setJump({ heading: { id: '', text: '', line, index: 0, level: 1 }, nonce: Date.now() }); }} /></aside>}{!aiOpened && showOutline && <aside className="external-outline" aria-label={t('目录')} style={{ width: outlineWidth }}>
      <div className="external-outline-resizer" role="separator" aria-label={t('调整目录宽度')} aria-orientation="vertical" tabIndex={0} title={t('拖动调整宽度 · 双击恢复默认')} onPointerDown={startOutlineResize} onPointerMove={moveOutlineResize} onPointerUp={finishOutlineResize} onPointerCancel={finishOutlineResize} onLostPointerCapture={finishOutlineResize} onDoubleClick={() => setOutlineWidth(190)} onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); setOutlineWidth(constrainOutlineWidth(event.currentTarget.parentElement!.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 16 : -16))); }} />
      <div className="external-outline-list" aria-busy={outlineState === 'loading'}>{outlineState === 'loading' && <Text size="xs" c="dimmed" role="status">{t('目录正在加载…')}</Text>}{outline.map((heading, i) => <button key={i} style={{ paddingLeft: 8 + heading.level * 8 }} onClick={() => setJump({ heading, nonce: Date.now() })}>{heading.text}</button>)}</div>
    </aside>}</div>
  </main>;
}
