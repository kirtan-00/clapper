// The shot list for one scene — the middle level of Scene > Shot > Take.
//
// This is the screen an AD works from: every setup the scene needs, in the
// order the shotlist prints them, with the ones already in the can marked off.
// Tapping a shot opens the rolling screen for it. Once you are there you can
// step to the next setup without coming back, so this screen is for planning
// and for jumping, not for the hop between two adjacent takes.

import { useEffect, useState } from 'react';
import type { Project, Shot, Slate, Take } from '../types';
import { store } from '../store';
import { Rail } from './common';
import { useScrolled } from './glist';
import { BackButton, ForwardMark } from './marks';
import { sizeInWords } from './shotlist';
import { tc } from '../export/timecode';

interface ShotStat {
  shot: Shot;
  takeCount: number;
  goodCount: number;
  totalMs: number;
}

export function ShotsScreen(props: {
  project: Project;
  slate: Slate;
  /** The name of the screen BACK lands on. The router knows it; this does not. */
  backLabel: string;
  onBack: () => void;
  onOpenShot: (shot: Shot) => void;
}) {
  const { project, slate } = props;
  const shots = slate.shots ?? [];
  const [stats, setStats] = useState<ShotStat[] | null>(null);
  // Takes logged against the scene itself rather than any shot — legacy rows,
  // or anything rolled before the breakdown was imported. Never hidden.
  const [looseTakes, setLooseTakes] = useState<Take[]>([]);

  useEffect(() => {
    let active = true;
    void store.listTakes(slate.id).then((takes) => {
      if (!active) return;
      const byShot = new Map<string, Take[]>();
      const loose: Take[] = [];
      for (const t of takes) {
        if (!t.shotId) {
          loose.push(t);
          continue;
        }
        const list = byShot.get(t.shotId);
        if (list) list.push(t);
        else byShot.set(t.shotId, [t]);
      }
      setStats(
        [...shots]
          .sort((a, b) => a.order - b.order)
          .map((shot) => {
            const mine = byShot.get(shot.id) ?? [];
            const good = mine.filter((t) => t.status === 'good');
            return {
              shot,
              takeCount: mine.length,
              goodCount: good.length,
              totalMs: good.reduce((n, t) => n + t.durationMs, 0),
            };
          }),
      );
      setLooseTakes(loose);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate.id]);

  const covered = stats ? stats.filter((s) => s.goodCount > 0).length : 0;

  // The nav bar is sticky material; the hairline under it arrives only once
  // there is a list behind it to separate from.
  const scrolled = useScrolled();

  return (
    <div className="app">
      <div className="topbar" data-scrolled={scrolled ? '' : undefined}>
        <BackButton label={props.backLabel} onClick={props.onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="topbar__title">{slate.name}</h1>
          <div className="topbar__sub">
            {shots.length} shots
            {stats && (
              <>
                {' '}
                <span aria-hidden="true">&middot;</span> {covered} in the can
              </>
            )}
          </div>
        </div>
      </div>

      <Rail thin />

      {slate.summary && <p className="shots__summary">{slate.summary}</p>}

      <section className="section">
        <div className="section__head">
          <span className="label">Shots</span>
          {stats && stats.length > 0 && (
            <span className="section__note">
              {covered}/{stats.length} covered
            </span>
          )}
        </div>

        {stats === null ? (
          <div className="empty">Loading shots</div>
        ) : (
          <div className="stack">
            {stats.map(({ shot, takeCount, goodCount, totalMs }) => (
              <div key={shot.id} className="cardrow">
                <button
                  type="button"
                  className={`card${goodCount > 0 ? ' card--done' : ''}`}
                  onClick={() => props.onOpenShot(shot)}
                >
                  <div className="card__row">
                    <span
                      className={`scene-dot${goodCount > 0 ? ' scene-dot--done' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="shotcode tnum">{shot.code}</span>
                    <span className="card__name shotspec">
                      {[sizeInWords(shot.size), shot.move].filter(Boolean).join(' · ') || '—'}
                    </span>
                    {takeCount > 0 && <span className="card__count">{takeCount}</span>}
                    <span className="card__chevron" aria-hidden="true">
                      <ForwardMark />
                    </span>
                  </div>
                  {shot.action && <div className="card__summary">{shot.action}</div>}
                  {shot.dialogue && <div className="shotline">&ldquo;{shot.dialogue}&rdquo;</div>}
                  {takeCount > 0 && (
                    <div className="card__meta">
                      <span>
                        {goodCount} of {takeCount} kept
                      </span>
                      {totalMs > 0 && (
                        <span>
                          roll <b>{tc.msToClock(totalMs)}</b>
                        </span>
                      )}
                    </div>
                  )}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Takes rolled against the scene before it had a breakdown. Shown so
            nothing a user logged can silently disappear behind the new level. */}
        {looseTakes.length > 0 && (
          <p className="camnote" style={{ marginTop: 12, marginBottom: 0 }}>
            {looseTakes.length} take{looseTakes.length === 1 ? '' : 's'} on this scene were rolled
            without a shot. They stay in every export.
          </p>
        )}
      </section>
    </div>
  );
}
