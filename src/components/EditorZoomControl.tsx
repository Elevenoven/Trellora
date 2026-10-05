import { EDITOR_ZOOM_MIN as ZOOM_MIN, EDITOR_ZOOM_MAX as ZOOM_MAX, EDITOR_ZOOM_STEP as ZOOM_STEP } from '../../shared/editorPreferences';
import { t, useI18n } from '../i18n';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useState } from 'react';


interface EditorZoomControlProps {
    value: number;
    defaultValue?: number;
    onChange: (value: number) => void;
}

function clampZoom(value: number): number {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function roundZoom(value: number): number {
    return Math.round(clampZoom(value) * 100) / 100;
}

const EditorZoomControl: React.FC<EditorZoomControlProps> = ({ value, defaultValue = 1, onChange }) => {
  useI18n();
    const [isOpen, setIsOpen] = useState(false);
    const percent = Math.round(value * 100);
    const updateZoom = (delta: number) => onChange(roundZoom(value + delta));

    return (
        <div
            className={`editor-zoom-control${isOpen ? ' is-open' : ''}`}
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
            onKeyDown={event => {
                if (isOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    setIsOpen(false);
                }
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOpen(false);
            }}
        >
            <button
                type="button"
                className="editor-zoom-trigger"
                aria-label={t("编辑器缩放，当前 {0}%", { '0': percent })}
                aria-expanded={isOpen}
                title={t("编辑器缩放")}
                onClick={() => setIsOpen(true)}
            >
                <ZoomIn size={15} aria-hidden="true" />
                <span>{percent}%</span>
            </button>
            <div className="editor-zoom-popover" role="group" aria-label={t("编辑器缩放控制")}>
                <span className="editor-zoom-value" aria-live="polite">{percent}%</span>
                <button type="button" className="editor-zoom-step" aria-label={t("放大")} title={t("放大")} disabled={value >= ZOOM_MAX} onClick={() => updateZoom(ZOOM_STEP)}>
                    <ZoomIn size={14} aria-hidden="true" />
                </button>
                <input
                    className="editor-zoom-slider"
                    type="range"
                    min={ZOOM_MIN}
                    max={ZOOM_MAX}
                    step={ZOOM_STEP}
                    value={value}
                    aria-label={t("纵向调整编辑器缩放")}
                    aria-orientation="vertical"
                    onChange={(event) => onChange(roundZoom(Number(event.currentTarget.value)))}
                />
                <button type="button" className="editor-zoom-step" aria-label={t("缩小")} title={t("缩小")} disabled={value <= ZOOM_MIN} onClick={() => updateZoom(-ZOOM_STEP)}>
                    <ZoomOut size={14} aria-hidden="true" />
                </button>
                <button type="button" className="editor-zoom-reset" onClick={() => onChange(defaultValue)}>{t("恢复默认缩放")}</button>
            </div>
        </div>
    );
};

export default EditorZoomControl;
