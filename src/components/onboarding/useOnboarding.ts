import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingAction, OnboardingState, OnboardingStep } from '../../../shared/onboarding';
import { t } from '../../i18n';

/** Main owns progress; local state only controls review and presentation. */
export function useOnboarding(ready: boolean) {
  const [state, setState] = useState<OnboardingState>();
  const [localStep, setLocalStep] = useState<OnboardingStep | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [reviewId, setReviewId] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const accept = useCallback((next: OnboardingState) => {
    setState(current => !current || next.revision >= current.revision ? next : current);
    return next;
  }, []);
  const refresh = useCallback(() => window.electronAPI.getOnboardingState().then(accept), [accept]);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const unsubscribe = window.electronAPI.onOnboardingStateChanged(next => { if (alive) accept(next); });
    void refresh().catch(() => { if (alive) setError(t('引导状态读取失败，请重试。')); });
    const onFocus = () => { void refresh().catch(() => undefined); };
    window.addEventListener('focus', onFocus);
    return () => { alive = false; unsubscribe(); window.removeEventListener('focus', onFocus); };
  }, [accept, ready, refresh]);
  const act = useCallback(async (action: OnboardingAction) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const current = await refresh();
      const next = accept(await window.electronAPI.updateOnboardingState({ action, expectedRevision: current.revision }));
      setLocalStep(null);
      if (action === 'finish') setCelebrate(true);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? t(failure.message) : t('引导状态保存失败，请重试。'));
      await refresh().catch(() => undefined);
    } finally { lock.current = false; setBusy(false); }
  }, [accept, refresh]);
  const open = useCallback(async () => {
    const current = await refresh(); setCelebrate(false);
    if (current.status === 'completed') { setReviewId(id => id + 1); setLocalStep('menus'); }
    else await act(current.status === 'deferred' ? 'resume' : 'start');
  }, [act, refresh]);
  const pause = useCallback(async () => {
    if (state?.status === 'completed') { setLocalStep(null); setCelebrate(false); }
    else await act('defer');
  }, [act, state?.status]);
  const nextMenus = useCallback(async () => {
    if (state?.status === 'completed') { setLocalStep('ai'); return; }
    if (state?.status === 'pending') { const started = await act('start'); if (!started) return; }
    await act(state?.progress.menus === 'done' ? 'show-ai' : 'acknowledge-menus');
  }, [act, state]);
  const nextQuestion = useCallback(async () => {
    if (state?.status === 'completed') setLocalStep('question');
    else await act('show-question');
  }, [act, state?.status]);
  const visible = Boolean(state && (state.status === 'pending' || state.status === 'active' || localStep || celebrate));
  return { state, step: localStep ?? state?.currentStep ?? 'menus', visible, review: state?.status === 'completed' && !celebrate,
    celebrate, reviewId, busy, error, act, open, pause, nextMenus, nextQuestion, refresh,
    backMenus: () => setLocalStep('menus'), backAi: () => state?.status === 'completed' ? setLocalStep('ai') : void act('show-ai'),
    closeCelebration: () => setCelebrate(false) };
}
export type OnboardingController = ReturnType<typeof useOnboarding>;
