import { t, useI18n } from '../../i18n';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

interface WikiSplitPaneProps {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryOpen: boolean;
  overlay: boolean;
}

const minPaneWidth = 420;

export default function WikiSplitPane({ primary, secondary, secondaryOpen, overlay }: WikiSplitPaneProps) {
  useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [primaryRatio, setPrimaryRatio] = useState(0.5);

  const updateRatio = useCallback((clientX: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= minPaneWidth * 2) return;
    const minimumRatio = minPaneWidth / bounds.width;
    const nextRatio = (clientX - bounds.left) / bounds.width;
    setPrimaryRatio(Math.min(1 - minimumRatio, Math.max(minimumRatio, nextRatio)));
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    updateRatio(event.clientX);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateRatio(event.clientX);
  };

  useEffect(() => {
    if (!secondaryOpen) setPrimaryRatio(0.5);
  }, [secondaryOpen]);

  return (
    <div
      ref={containerRef}
      className={[
        'wiki-split-pane',
        secondaryOpen ? 'detail-open' : '',
        overlay ? 'detail-overlay' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--wiki-primary-width': `${primaryRatio * 100}%` } as CSSProperties}
    >
      <section className="wiki-split-primary">{primary}</section>
      {secondaryOpen && !overlay ? (
        <div
          className="wiki-split-handle"
          role="separator"
          aria-label={t("调整导图与详情宽度")}
          aria-orientation="vertical"
          aria-valuemin={35}
          aria-valuemax={65}
          aria-valuenow={Math.round(primaryRatio * 100)}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setPrimaryRatio((ratio) => Math.max(0.35, ratio - 0.03));
            if (event.key === 'ArrowRight') setPrimaryRatio((ratio) => Math.min(0.65, ratio + 0.03));
            if (event.key === 'Home') setPrimaryRatio(0.5);
          }}
        ><span /></div>
      ) : null}
      {secondaryOpen ? <section className="wiki-split-secondary">{secondary}</section> : null}
    </div>
  );
}
