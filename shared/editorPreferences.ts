export interface EditorPreferences {
  editorFontSizePx: number;
  editorLineHeight: number;
  editorParagraphSpacingPx: number;
  editorContentWidth: 'narrow' | 'standard' | 'wide' | 'full';
  defaultEditorZoom: number;
  editorPasteMode: 'preserve-format' | 'plain-text';
  editorMarkdownAutoConvert: boolean;
  editorSelectionToolbarEnabled: boolean;
  editorFocusModeEnabled: boolean;
  editorTypewriterModeEnabled: boolean;
}

export const EDITOR_ZOOM_MIN = 0.75;
export const EDITOR_ZOOM_MAX = 1.5;
export const EDITOR_ZOOM_STEP = 0.05;
export const defaultEditorPreferences: EditorPreferences = {
  editorFontSizePx: 16, editorLineHeight: 1.7, editorParagraphSpacingPx: 12,
  editorContentWidth: 'standard', defaultEditorZoom: 1, editorPasteMode: 'preserve-format',
  editorMarkdownAutoConvert: true, editorSelectionToolbarEnabled: true,
  editorFocusModeEnabled: false, editorTypewriterModeEnabled: false,
};
export const editorPreferenceKeys = Object.keys(defaultEditorPreferences) as Array<keyof EditorPreferences>;
export const editorContentWidths = { narrow: 720, standard: 900, wide: 1120, full: 0 } as const;

/** Only finite numbers and explicit boolean/enum values enter persisted editor settings. */
export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const number = (key: keyof EditorPreferences, min: number, max: number, step: number) => {
    const n = v[key];
    return typeof n === 'number' && Number.isFinite(n)
      ? Number((min + Math.round((Math.max(min, Math.min(max, n)) - min) / step) * step).toFixed(2))
      : defaultEditorPreferences[key] as number;
  };
  const boolean = (key: keyof EditorPreferences) => typeof v[key] === 'boolean' ? v[key] as boolean : defaultEditorPreferences[key] as boolean;
  return {
    editorFontSizePx: number('editorFontSizePx', 12, 24, 1),
    editorLineHeight: number('editorLineHeight', 1.2, 2.4, 0.1),
    editorParagraphSpacingPx: number('editorParagraphSpacingPx', 0, 32, 1),
    editorContentWidth: typeof v.editorContentWidth === 'string' && ['narrow', 'standard', 'wide', 'full'].includes(v.editorContentWidth) ? v.editorContentWidth as EditorPreferences['editorContentWidth'] : 'standard',
    defaultEditorZoom: number('defaultEditorZoom', EDITOR_ZOOM_MIN, EDITOR_ZOOM_MAX, EDITOR_ZOOM_STEP),
    editorPasteMode: v.editorPasteMode === 'plain-text' ? 'plain-text' : 'preserve-format',
    editorMarkdownAutoConvert: boolean('editorMarkdownAutoConvert'),
    editorSelectionToolbarEnabled: boolean('editorSelectionToolbarEnabled'),
    editorFocusModeEnabled: boolean('editorFocusModeEnabled'),
    editorTypewriterModeEnabled: boolean('editorTypewriterModeEnabled'),
  };
}
