import { t, useI18n } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@mantine/core';
import { ChevronDown, FileText, Search, X } from 'lucide-react';
import type { UnifiedSearchOutcome, UnifiedSearchResult } from '../electron';

interface SearchModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectFile: (path: string, searchTerm?: string, target?: SearchNavigationTarget) => void;
}

export interface SearchNavigationTarget {
    heading?: string;
    snippet?: string;
}

const SEARCH_RESULTS_BATCH_SIZE = 10;

const SearchModal: React.FC<SearchModalProps> = ({ isOpen, onClose, onSelectFile }) => {
  useI18n();
    const [query, setQuery] = useState('');
    const [outcome, setOutcome] = useState<UnifiedSearchOutcome | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [visibleResultCount, setVisibleResultCount] = useState(SEARCH_RESULTS_BATCH_SIZE);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const requestIdRef = useRef(0);
    useEffect(() => {
        if (!isOpen) return;
        setQuery('');
        setOutcome(null);
        setSelectedIndex(0);
        setVisibleResultCount(SEARCH_RESULTS_BATCH_SIZE);
        const focusTimer = setTimeout(() => inputRef.current?.focus(), 30);
        return () => {
            clearTimeout(focusTimer);
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const normalized = query.trim();
        if (!normalized) {
            requestIdRef.current++;
            setOutcome(null);
            setIsSearching(false);
            setSelectedIndex(0);
            setVisibleResultCount(SEARCH_RESULTS_BATCH_SIZE);
            return;
        }
        const requestId = ++requestIdRef.current;
        setIsSearching(true);
        const timer = setTimeout(() => {
            void window.electronAPI.searchNotesUnified(normalized)
                .then((result) => {
                    if (requestId !== requestIdRef.current) return;
                    setOutcome(result);
                    setSelectedIndex(0);
                    setVisibleResultCount(SEARCH_RESULTS_BATCH_SIZE);
                })
                .catch(() => {
                    if (requestId !== requestIdRef.current) return;
                    setOutcome({
                        results: [],
                        mode: 'keyword',
                        used: '关键词搜索',
                        notice: t("搜索暂时无法完成，请稍后重试。"),
                    });
                })
                .finally(() => {
                    if (requestId === requestIdRef.current) setIsSearching(false);
                });
        }, 250);
        return () => clearTimeout(timer);
    }, [isOpen, query]);

    useEffect(() => {
        resultRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex, outcome?.results]);

    if (!isOpen) return null;
    const results = outcome?.results ?? [];
    const visibleResults = results.slice(0, visibleResultCount);
    const remainingResultCount = Math.max(0, results.length - visibleResults.length);
    const nextBatchSize = Math.min(SEARCH_RESULTS_BATCH_SIZE, remainingResultCount);

    const openResult = (result: UnifiedSearchResult) => {
        onSelectFile(
            result.path,
            result.searchTerm ?? query.trim(),
        );
        onClose();
    };

    return (
        <div className="search-overlay" onClick={onClose}>
            <section className="search-dialog" role="dialog" aria-modal="true" aria-label={t("搜索笔记")} onClick={(event) => event.stopPropagation()}>
                <header className="search-header">
                    <Search size={18} aria-hidden="true" />
                    <input
                        ref={inputRef}
                        value={query}
                        placeholder={t("搜索标题、正文、标签，或描述你想找的内容")}
                        aria-label={t("搜索标题、正文、标签，或描述你想找的内容")}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') onClose();
                            if (event.key === 'ArrowDown' && visibleResults.length > 0) {
                                event.preventDefault();
                                setSelectedIndex((index) => (index + 1) % visibleResults.length);
                            }
                            if (event.key === 'ArrowUp' && visibleResults.length > 0) {
                                event.preventDefault();
                                setSelectedIndex((index) => (index - 1 + visibleResults.length) % visibleResults.length);
                            }
                            if (event.key === 'Enter' && visibleResults[selectedIndex]) openResult(visibleResults[selectedIndex]);
                        }}
                    />
                    {isSearching ? <span className="search-progress">{t("搜索中…")}</span> : null}
                    <button type="button" className="icon-button" aria-label={t("关闭搜索")} onClick={onClose}><X size={16} /></button>
                </header>

                {outcome?.notice ? (
                    <div className="search-notice" role="status">
                        <div>{outcome.notice}</div>
                    </div>
                ) : null}

                <div className="search-results">
                    {!query.trim() ? (
                        <div className="search-empty">{t("输入关键词或描述，即可搜索本地笔记。")}</div>
                    ) : !isSearching && results.length === 0 ? (
                        <div className="search-empty">
                            {t("没有找到匹配的笔记。可以尝试缩短关键词或换一种描述。")}
                        </div>
                    ) : (
                        <>
                            <div
                                role="listbox"
                                aria-label={t("搜索结果，已显示 {0} 条，共 {1} 条", { '0': visibleResults.length, '1': results.length })}
                            >
                                {visibleResults.map((result, index) => (
                                    <button
                                        key={`${result.path}-${result.heading ?? ''}`}
                                        ref={(element) => { resultRefs.current[index] = element; }}
                                        type="button"
                                        role="option"
                                        aria-selected={selectedIndex === index}
                                        className={`search-result${selectedIndex === index ? ' selected' : ''}`}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        onClick={() => openResult(result)}
                                    >
                                        <div className="search-result-title">
                                            <FileText size={14} aria-hidden="true" />
                                            <strong>{result.title}</strong>
                                            <span className="search-result-badges">
                                                {result.matchTypes.map((matchType) => <span key={matchType}>{t("关键词匹配")}</span>)}
                                            </span>
                                        </div>
                                        <div className="search-result-path" title={result.relativePath}>{result.relativePath}</div>
                                        {result.heading ? <div className="search-result-heading">{t("所在标题：")}{result.heading}</div> : null}
                                        {result.snippet ? <div className="search-result-snippet">{result.snippet}</div> : null}
                                    </button>
                                ))}
                            </div>
                            {remainingResultCount > 0 ? (
                                <div className="search-load-more">
                                    <Button
                                        type="button"
                                        variant="subtle"
                                        color="brand"
                                        size="compact-sm"
                                        rightSection={<ChevronDown size={14} aria-hidden="true" />}
                                        onClick={() => setVisibleResultCount((count) => Math.min(count + SEARCH_RESULTS_BATCH_SIZE, results.length))}
                                    >
                                        {t("继续查看下")} {nextBatchSize} {t("条")}
                                    </Button>
                                    <span className="search-load-more-count" aria-live="polite">
                                        {t("已显示")} {visibleResults.length} / {results.length}
                                    </span>
                                </div>
                            ) : null}
                        </>
                    )}
                </div>

                <footer className="search-footer">
                    <span>{outcome?.used ?? t("关键词搜索")}</span>
                    <span>{t("关键词搜索可用")}</span>
                    <span>{t("↑↓ 选择 · Enter 打开 · Esc 关闭")}</span>
                </footer>
            </section>
        </div>
    );
};

export default SearchModal;
