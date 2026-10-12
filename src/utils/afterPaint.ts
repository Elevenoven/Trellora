/** Leave two frame opportunities before optional work; cancellation also covers StrictMode remounts. */
export function scheduleAfterPaint(task: () => void, delayMs = 0): () => void {
    let firstFrame = 0, secondFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const schedule = () => {
        if (cancelled || document.hidden) return;
        document.removeEventListener('visibilitychange', schedule);
        firstFrame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => {
                timer = setTimeout(() => { if (!cancelled) task(); }, delayMs);
            });
        });
    };
    if (document.hidden) document.addEventListener('visibilitychange', schedule);
    else schedule();
    return () => {
        cancelled = true;
        cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame);
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', schedule);
    };
}
