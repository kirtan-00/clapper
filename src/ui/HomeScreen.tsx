// HOME — the gateway tab, and the reason the shell exists.
//
// One job above all others: NEW ROLL. Cold app to a rolling screen in a single
// tap, with no project-setup ceremony in between. Everything else on this
// screen is quieter than that button on purpose — a grouped inset list under a
// hero, the iOS shape, so the eye lands on the one thing worth landing on at
// 5am with a slate in the other hand.
//
// What is deliberately NOT here:
//   PODCAST MODE renders nothing at all until it exists. A greyed-out row is a
//     promise you have to keep; an absent row is a screen that tells the truth.
//   NEW PROJECT stays on the Projects tab. Home is for getting rolling, not for
//     configuring; the full setup sheet lives where the projects do.
//
// The tray unmounts itself on `rolling` (see AppShell), so pushing straight to
// a roll from here needs no special handling.

import { useEffect, useState } from 'react';
import type { Project } from '../types';
import type { Nav } from './nav';
import { Rail } from './common';
import { useScrolled } from './glist';
import InstallNudge from './InstallNudge';
import { ShotlistSheet } from './ShotlistSheet';
import { readResume, startNewRoll, type ResumeInfo } from './newRoll';
import * as haptics from './haptics';

// One weight, one 24 grid, round caps and joins, currentColor: the same hand
// TabTray's marks are drawn in, so a row icon and a tab icon read as one set.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const SVG = { viewBox: '0 0 24 24', 'aria-hidden': true, focusable: 'false' as const };

/** The lens, open. Stroked, never a filled dot: a filled dot is REC, and REC is
 *  red and means something else. */
function RollMark() {
  return (
    <svg {...SVG} className="home-hero__mark">
      <circle cx="12" cy="12" r="8.5" {...STROKE} />
      <circle cx="12" cy="12" r="3.4" {...STROKE} />
    </svg>
  );
}

/** A page of numbered rows: the shot division as it comes off the printer. */
function ListMark() {
  return (
    <svg {...SVG} className="home-mark">
      <path d="M6.5 3.5h8L19 8v12.5H6.5z" {...STROKE} />
      <path d="M14 3.5V8h5" {...STROKE} />
      <path d="M9.5 12h6M9.5 15.5h6" {...STROKE} />
    </svg>
  );
}

/** One slate, front on: the project you were last standing in. */
function SlateMark() {
  return (
    <svg {...SVG} className="home-mark">
      <rect x="3.5" y="9" width="17" height="11.5" rx="2.5" {...STROKE} />
      <path d="M3.5 9V5.6L19.5 3.8a1.1 1.1 0 0 1 1 1.1V9" {...STROKE} />
      <path d="M8.6 5 7.3 9M14 4.4 12.7 9" {...STROKE} />
    </svg>
  );
}

/**
 * The disclosure chevron. THE ONE STROKE IN THE SET THAT IS NOT 1.75, and the
 * exception is deliberate: `.grow-chev` renders at 13px where the tab icons
 * render at 22, so 1.75 on this viewBox lands at 0.95 device px and the mark
 * goes to a hairline while everything around it stays solid. 2.2 at 13px is
 * ~1.2 device px, still LIGHTER than the tray's icons at ~1.6 — it matches the
 * set optically, which is the rule the 1.75 exists to serve. iOS does the same
 * thing: its list chevron is a heavier weight at a smaller point size than the
 * symbols above it. Anything else drawing a `.grow-chev` should copy this
 * number rather than "fix" it, or rows will differ from tab to tab.
 */
function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="home-chev">
      <path d="M9.5 4.5 17 12l-7.5 7.5" {...STROKE} strokeWidth={2.2} />
    </svg>
  );
}

export function HomeScreen(props: { nav: Nav }) {
  const { nav } = props;
  // undefined = still reading the store, null = nothing on this phone yet.
  const [resume, setResume] = useState<ResumeInfo | null | undefined>(undefined);
  const [rolling, setRolling] = useState(false);
  const [shotlist, setShotlist] = useState(false);
  // The masthead bar is sticky material and the title shrinks into it, same
  // contract the Settings and Account headers run on.
  const scrolled = useScrolled();

  useEffect(() => {
    let active = true;
    void readResume()
      .then((r) => {
        if (active) setResume(r);
      })
      .catch(() => {
        if (active) setResume(null);
      });
    return () => {
      active = false;
    };
  }, []);

  /**
   * The hero. Guarded against a double tap because it can CREATE — two taps
   * racing would otherwise stand up two scratch projects for one shoot.
   *
   * Pushes TWO screens, project then rolling, rather than jumping straight to
   * the roll. The rolling screen's "next scene" move is a `popTo('project')`
   * followed by a push (see App.tsx), which on a stack with no project screen
   * under it would quietly grow sideways forever. Backing out of the roll
   * landing on the project is also simply correct.
   */
  async function onNewRoll() {
    if (rolling) return;
    setRolling(true);
    haptics.tap();
    try {
      const target = await startNewRoll();
      nav.push({ name: 'project', project: target.project });
      nav.push({
        name: 'rolling',
        project: target.project,
        slate: target.slate,
        shot: target.shot,
      });
    } catch {
      setRolling(false);
    }
  }

  function openProject(project: Project) {
    haptics.tap();
    nav.push({ name: 'project', project });
  }

  const heroSub = rolling
    ? 'Opening the slate…'
    : resume
      ? `Back into ${resume.project.name}`
      : 'Makes a project for today and drops you on the slate';

  return (
    <div className="app home" data-scrolled={scrolled ? '' : undefined}>
      <header className="ltop home-head" data-scrolled={scrolled ? '' : undefined}>
        <div className="masthead__mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <h1 className="ltitle">Clapper</h1>
      </header>

      <InstallNudge />

      <button
        type="button"
        className="home-hero"
        disabled={rolling}
        onClick={() => void onNewRoll()}
      >
        <RollMark />
        <span className="home-hero__text">
          <span className="home-hero__title">New roll</span>
          <span className="home-hero__sub">{heroSub}</span>
        </span>
      </button>

      <div className="home-rail">
        <Rail thin />
      </div>

      {resume && (
        <section className="glist">
          <h2 className="glist-hdr">Where you were</h2>
          <div className="glist-card">
            <button
              type="button"
              className="grow"
              data-icon=""
              onClick={() => openProject(resume.project)}
            >
              <span className="grow-icon">
                <SlateMark />
              </span>
              <span className="home-rowtext">
                <span className="home-rowtext__name">{resume.project.name}</span>
                <span className="home-rowtext__meta">
                  {resume.day ? (
                    <>
                      <b>
                        Day <span className="tnum">{resume.day}</span>
                      </b>
                      <i aria-hidden="true">·</i>
                    </>
                  ) : null}
                  <span className="tnum">{resume.takeCount}</span>
                  <span>{resume.takeCount === 1 ? 'take' : 'takes'}</span>
                  <i aria-hidden="true">·</i>
                  <span className="tnum">{resume.sceneCount}</span>
                  <span>{resume.sceneCount === 1 ? 'scene' : 'scenes'}</span>
                </span>
              </span>
              <span className="grow-chev">
                <Chevron />
              </span>
            </button>
          </div>
        </section>
      )}

      <section className="glist">
        <h2 className="glist-hdr">Start from paper</h2>
        <div className="glist-card">
          <button
            type="button"
            className="grow"
            data-icon=""
            onClick={() => {
              haptics.tap();
              setShotlist(true);
            }}
          >
            <span className="grow-icon">
              <ListMark />
            </span>
            <span className="grow-label">Shotlist · from a PDF</span>
            <span className="grow-chev">
              <Chevron />
            </span>
          </button>
        </div>
        <p className="glist-note">
          Every scene and every numbered shot, read off the document and laid out as scenes you can
          tap. Two example breakdowns are built in if you have nothing to hand.
        </p>
      </section>

      {/* Podcast mode lands here in a later phase. Nothing is drawn for it on
          purpose — see the note at the top of this file. */}

      {resume === null && (
        <p className="home-first">
          Nothing logged on this phone yet. New roll is the whole setup: it opens a project named
          for today, adds a scene, and starts the slate. You can rename any of it later.
        </p>
      )}

      {shotlist && (
        <ShotlistSheet
          onClose={() => setShotlist(false)}
          onImported={(project) => {
            setShotlist(false);
            // The project it just made belongs with the projects. Reset that
            // tab first so BACK out of it is the list, not wherever the
            // Projects stack happened to be left.
            nav.switchTab('projects', { reset: true });
            nav.push({ name: 'project', project });
          }}
        />
      )}
    </div>
  );
}
