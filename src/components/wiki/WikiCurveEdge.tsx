import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { createWikiCurvePath } from '../../wiki/wikiLayout';

export type WikiCurveEdgeData = {
  branchColor: string;
  highlighted: boolean;
  dragging: boolean;
  settling: boolean;
};

export type WikiFlowEdge = Edge<WikiCurveEdgeData, 'wikiCurve'>;

export default function WikiCurveEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<WikiFlowEdge>) {
  const className = [
    'wiki-map-edge',
    data?.highlighted ? 'highlighted' : '',
    data?.dragging ? 'dragging' : '',
    data?.settling ? 'settling' : '',
  ].filter(Boolean).join(' ');
  return (
    <BaseEdge
      path={createWikiCurvePath(sourceX, sourceY, targetX, targetY)}
      className={className}
      style={{ '--wiki-branch-color': data?.branchColor } as CSSProperties}
    />
  );
}
