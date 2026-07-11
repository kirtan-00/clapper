import { useCallback, useEffect, useRef, useState } from 'react';
import type { RollTimer } from '../types';

/**
 * Roll timer hook. elapsedMs is ALWAYS recomputed from Date.now() - startedAt
 * (never interval accumulation), so tab-backgrounding or screen lock can
 * never drift it. The ~100ms interval only controls repaint cadence.
 */
export function useRollTimer(): RollTimer {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => {
      setElapsedMs(Date.now() - startedAt);
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAt]);

  const start = useCallback(() => {
    if (startedAtRef.current !== null) return; // already rolling
    const now = Date.now();
    startedAtRef.current = now;
    setStartedAt(now);
    setElapsedMs(0);
  }, []);

  const stop = useCallback((): { startedAt: number; durationMs: number } => {
    const began = startedAtRef.current;
    startedAtRef.current = null;
    setStartedAt(null);
    setElapsedMs(0);
    if (began === null) {
      // stop() while idle: nothing was rolling, report a zero-length roll.
      const now = Date.now();
      return { startedAt: now, durationMs: 0 };
    }
    return { startedAt: began, durationMs: Date.now() - began };
  }, []);

  return {
    rolling: startedAt !== null,
    startedAt,
    elapsedMs,
    start,
    stop,
  };
}
