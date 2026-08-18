// HOME — the gateway tab, and the reason the shell exists.
//
// One job above all others: NEW ROLL. Cold app to a rolling screen in one or
// two taps, with no project-setup ceremony in between. Everything else on
// this screen is quieter than that button on purpose — a grouped inset list
// under a hero, the iOS shape, so the eye lands on the one thing worth
// landing on at 5am with a slate in the other hand.
//
// The hero opens a picker sheet with the two ways a shoot starts:
//
//   DIRECTOR MODE — a shot list, uploaded as a PDF. Routes straight to
//     ShotlistSheet, which already owns that entire flow end to end; nothing
//     about it is rebuilt here.
//   PODCAST MODE — no shot list, no scene list, no shot picker. One
//     continuous take, tapped for what happens as it happens. It rides the
//     exact same take/moment engine RollingScreen already runs for a
//     hand-made scene with no breakdown — a podcast recording IS that scene,
//     just resumed from its own pool of projects (see newRoll.ts).
//
// What is deliberately NOT here: NEW PROJECT stays on the Projects tab. Home
// is for getting rolling, not for configuring; the full setup sheet lives
// where the projects do.
//
// The tray unmounts itself on `rolling` (see AppShell), so pushing straight to
// a roll from here needs no special handling.

import { useEffect, useState } from 'react';
import type { Project } from '../types';
import type { Nav } from './nav';
import { Rail, Sheet, SheetClose } from './common';
import { useScrolled } from './glist';
import InstallNudge from './InstallNudge';
import { ShotlistSheet } from './ShotlistSheet';
import { readResume, startPodcastRoll, type ResumeInfo } from './newRoll';
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

/** A microphone — closed capsule, stand and base, one weight with every other
 *  mark in this file. Podcast mode's own icon, beside ListMark's page-of-rows
 *  for Director mode, in the picker sheet. */
function PodcastMark() {
  return (
    <svg {...SVG} className="home-mark">
      <rect x="9" y="3.5" width="6" height="11" rx="3" {...STROKE} />
      <path d="M6 11v1.5a6 6 0 0 0 12 0V11" {...STROKE} />
      <path d="M12 18.5V21M9 21h6" {...STROKE} />
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
  // The picker sheet the hero opens — Director or Podcast. Podcast's own row
  // does async work (it can CREATE a project) and gets its own busy guard;
  // Director just hands off to ShotlistSheet, which owns its own busy state.
  const [showPicker, setShowPicker] = useState(false);
  const [startingPodcast, setStartingPodcast] = useState(false);
  const [shotlist, setShotlist] = useState(false);
  // The title bar is sticky material and the large title shrinks into it, the
  // same contract the Settings and Account headers run on.
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

  /** Director row: hand off to ShotlistSheet — same swap-in-place move the
   *  sign-in gate already makes when ReadStep needs a different sheet
   *  entirely (see ShotlistSheet.tsx), not a coordinated close-then-open. */
  function pickDirector() {
    haptics.tap();
    setShowPicker(false);
    setShotlist(true);
  }

  /**
   * Podcast row. Guarded against a double tap because it can CREATE — two
   * taps racing would otherwise stand up two scratch podcast projects for one
   * session.
   *
   * Pushes TWO screens, project then rolling, rather than jumping straight to
   * the roll — same contract Director mode's project lands on and the same
   * reason: the rolling screen's "next scene" move is a `popTo('project')`
   * followed by a push (see App.tsx), which on a stack with no project screen
   * under it would quietly grow sideways forever.
   */
  async function pickPodcast() {
    if (startingPodcast) return;
    setStartingPodcast(true);
    haptics.tap();
    try {
      const target = await startPodcastRoll();
      setShowPicker(false);
      nav.push({ name: 'project', project: target.project });
      nav.push({
        name: 'rolling',
        project: target.project,
        slate: target.slate,
        shot: target.shot,
      });
    } catch {
      setStartingPodcast(false);
    }
  }

  function openProject(project: Project) {
    haptics.tap();
    nav.push({ name: 'project', project });
  }

  return (
    <div className="app home" data-scrolled={scrolled ? '' : undefined}>
      {/* No app icon and no wordmark. A logo lockup at the top of a screen is a
          WEBSITE header; the OS already showed the icon on the way in, and the
          tab underneath already says which tab this is. What is left is the
          plain large title every other tab root carries, so the four roots read
          as one stack rather than one branded page and three app screens. */}
      <header className="ltop" data-scrolled={scrolled ? '' : undefined}>
        <h1 className="ltitle">Home</h1>
      </header>

      <InstallNudge />

      <button
        type="button"
        className="home-hero"
        onClick={() => {
          haptics.tap();
          setShowPicker(true);
        }}
      >
        <RollMark />
        <span className="home-hero__text">
          <span className="home-hero__title">New roll</span>
          <span className="home-hero__sub">A shot list, or a blank roll with markers</span>
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

      {/* The first-run paragraph is gone. It explained what NEW ROLL does, which
          is what the hero's own sub-line already says, one line above it and in
          the button that does it. */}

      {showPicker && (
        <Sheet title="New roll" onClose={() => setShowPicker(false)}>
          <div className="modepick-list">
            <button type="button" className="btn sp-example modepick" onClick={pickDirector}>
              <span className="modepick__icon">
                <ListMark />
              </span>
              <span className="modepick__text">
                <b>Director mode</b>
                <span>Upload a shot list PDF</span>
              </span>
            </button>
            <button
              type="button"
              className="btn sp-example modepick"
              disabled={startingPodcast}
              onClick={() => void pickPodcast()}
            >
              <span className="modepick__icon">
                <PodcastMark />
              </span>
              <span className="modepick__text">
                <b>Podcast mode</b>
                <span>{startingPodcast ? 'Opening the slate…' : 'Roll long, tap markers as it happens'}</span>
              </span>
            </button>
          </div>
          <div className="sheet__actions">
            <SheetClose className="btn btn--ghost" onClose={() => setShowPicker(false)}>
              Cancel
            </SheetClose>
          </div>
        </Sheet>
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
