import { readMaterialDirectLoadDocuments, type MaterialDirectLoadDocument } from '../pipeline/materialChunkSearch';

/** 小文档直载阈值：子块数 ≤ 40 视为小文档（借鉴 WeKnora 50 chunk 直载思想）；第一版常量，不进设置面板。 */
export const DIRECT_LOAD_MAX_CHILD_CHUNKS = 40;
/** 直载父块总预算：防止小文档淹没检索证据。 */
export const DIRECT_LOAD_MAX_PARENTS = 4;

export interface DirectLoadParentCandidate {
  documentId: string;
  parentChunkId: string;
  parentOrdinal: number;
  text: string;
  sourceText: string;
  directLoad: true;
}

export interface DirectLoadOutcome {
  candidates: DirectLoadParentCandidate[];
  documentIds: string[];
}

/** 纯决策：按子块数升序选小文档，父块数累计不超预算才整文档直载（避免半截文档）。 */
export function selectDirectLoadDocuments(documents: MaterialDirectLoadDocument[], maxParents: number): MaterialDirectLoadDocument[] {
  const ordered = [...documents].sort((first, second) => first.childChunks - second.childChunks || first.documentId.localeCompare(second.documentId));
  const selected: MaterialDirectLoadDocument[] = [];
  let budget = Math.max(0, Math.floor(maxParents));
  for (const document of ordered) {
    if (document.parents.length === 0 || document.parents.length > budget) continue;
    selected.push(document);
    budget -= document.parents.length;
    if (budget <= 0) break;
  }
  return selected;
}

/**
 * 小文档直载通道：未限定 documentIds 的库级检索场景下，小文档跳过召回与
 * rerank 直进候选池（视为高相关，最终分取归一上限）。只读，失败返回空。
 */
export function readDirectLoadCandidates(libraryPath: string): DirectLoadOutcome {
  let documents: MaterialDirectLoadDocument[] = [];
  try {
    documents = readMaterialDirectLoadDocuments({
      libraryPath,
      maxChildChunks: DIRECT_LOAD_MAX_CHILD_CHUNKS,
      maxParents: DIRECT_LOAD_MAX_PARENTS,
    });
  } catch {
    return { candidates: [], documentIds: [] };
  }
  const selected = selectDirectLoadDocuments(documents, DIRECT_LOAD_MAX_PARENTS);
  const candidates: DirectLoadParentCandidate[] = selected.flatMap((document) => document.parents.map((parent) => ({
    documentId: document.documentId,
    parentChunkId: parent.parentChunkId,
    parentOrdinal: parent.ordinal,
    text: parent.text,
    sourceText: parent.sourceText,
    directLoad: true as const,
  })));
  return { candidates, documentIds: selected.map((document) => document.documentId) };
}
