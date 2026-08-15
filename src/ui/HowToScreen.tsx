// "How to use" — the full-window guide, moved out of ProjectsScreen and onto
// the Settings tab. The prose is unchanged; only its address is.
//
// Not a sheet: this is documentation a crew member reads standing up,
// one-handed, in daylight, so it gets the whole viewport, its own scroller, a
// sticky header and jump chips. `.guide` is `position: fixed; inset: 0` at
// z-index 60, above the tray's 30.
//
// THE useFullScreenClaim() CALL BELOW IS LOAD-BEARING. It is what unmounts the
// tab tray while this is up. The tray is dropped from the tree rather than
// hidden, because a merely-hidden bar still takes part in layout — the same
// mechanism carries the roll screen's contract that CUT is never off screen.
// Do not drop it when refactoring this file.
//
// Closing always goes through history.back(), never straight to setState: the
// opener pushes a history entry so Android's hardware BACK dismisses the guide
// instead of leaving the app. See openGuide in SettingsScreen.

import { useEffect, useRef } from 'react';
import { useFullScreenClaim } from './AppShell';
import * as haptics from './haptics';
import { BackButton } from './marks';

const GUIDE_NAV: { id: string; label: string }[] = [
  { id: 'g-what', label: 'What it is' },
  { id: 'g-setup', label: 'Setup' },
  { id: 'g-cams', label: 'Multiple cameras' },
  { id: 'g-onset', label: 'On set' },
  { id: 'g-status', label: 'Discard vs delete' },
  { id: 'g-fix', label: 'Fixing a number' },
  { id: 'g-scenes', label: 'Scene order' },
  { id: 'g-voice', label: 'Voice' },
  { id: 'g-out', label: 'Handing off' },
];

export function HowToScreen(props: { onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  // `.guide` is `position: fixed; inset: 0` — it IS the window while it is up.
  // Claiming it unmounts the tab tray (see AppShell), rather than leaving a bar
  // of chrome floating over documentation that owns the whole viewport.
  useFullScreenClaim();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function jump(id: string) {
    const el = scrollRef.current?.querySelector(`#${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="guide" role="dialog" aria-modal="true" aria-label="How Clapper works">
      <div className="guide__bar">
        <div className="guide__barrow">
          {/* Was a font-glyph arrow in a 44px box, plus the two-stripe app
              mark: the same website-header lockup that came off Home and
              Projects, and the second stripe on a surface that already ends in
              one. Now the house back button, saying where it goes. */}
          <BackButton
            label="Settings"
            onClick={() => {
              haptics.tap();
              onClose();
            }}
          />
          <h2 className="guide__title">How Clapper works</h2>
        </div>
        <div className="guide__nav">
          {GUIDE_NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className="guide__navchip"
              onClick={() => jump(n.id)}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      <div className="guide__scroll" ref={scrollRef}>
        <div className="guide__inner">
          {/* 1 ---------------------------------------------------------- */}
          <section className="gsec" id="g-what">
            <p className="gsec__num tnum">01</p>
            <h3 className="gsec__h">What Clapper is</h3>
            <p className="gsec__lede">
              Your shot log, built while you shoot instead of typed up afterwards.
            </p>
            <p>
              Every file a camera writes gets a clip number in its name. Someone has always had to
              copy that number onto a shot log by hand, off a monitor, between setups, hundreds of
              times a day. Get one digit wrong and the log stops matching the actual files, so the
              editor stops trusting it and starts opening card folders instead.
            </p>
            <p>
              Clapper keeps the count for you. It knows the last number it handed out, and every
              ROLL gives out the next one. You never write a clip number down, and the log always
              matches what is really on the card.
            </p>

            <div className="grule">
              <p className="grule__label">The one rule</p>
              <p className="grule__big">Hit ROLL every time a camera rolls. No exceptions.</p>
              <p>
                Clapper cannot see the camera. It can only count, and its count only matches the
                camera’s if you press ROLL exactly as many times as the camera actually rolled.
              </p>
              <p>
                Camera rolled by mistake? Still hit ROLL, then CUT, then <b>Discard</b> it. The
                camera already wrote a file, so that number is spent either way. Discarding uses it
                up correctly; skipping the roll does not, and every number after it is wrong for the
                rest of the day.
              </p>
            </div>
          </section>

          {/* 2 ---------------------------------------------------------- */}
          <section className="gsec" id="g-setup">
            <p className="gsec__num tnum">02</p>
            <h3 className="gsec__h">Setting up a project</h3>
            <p className="gsec__lede">
              Two minutes at the top of the day. Every numbering mistake starts here, not out on the
              floor.
            </p>
            <p>
              A project has two independent blocks: <b>Video</b>, for your camera or cameras, and{' '}
              <b>Audio</b>, for a sound recorder if you are using one. Each keeps its own running
              count, but every shot you log carries both together.
            </p>
            <p>
              <b>Video.</b> Pick 1 to 4 cameras. For each one, set the starting clip number and its
              clip format — prefix, number of digits, file extension. Read the last file already on
              the card and enter the next number, not 1. Match the format to a real file: C0001 and
              C001 are different names and will not relink in the edit.
            </p>
            <p>
              <b>Audio.</b> Turn it on only if a separate recorder is rolling sound. Set its file
              prefix (e.g. SND_), digit count and extension (e.g. .WAV) the same way, read off a
              real file on the recorder’s card.
            </p>
            <p>
              <b>Frame rate.</b> Match what the camera is shooting. It is what the exported timeline
              gets built at.
            </p>
            {/* RELOCATED from Home and from the shotlist sheet, both of which
                carried this as a paragraph at rest on every visit. It belongs
                here: it is read once, when you are deciding how to start. */}
            <p>
              <b>Starting from paper.</b> <b>Shotlist · from a PDF</b> on Home reads every scene and
              every numbered shot off a shot division (rows like 1.1, 1.2, with a size column) and
              lays them out as scenes you can tap, with the key moments inside each shot already
              worked out. Two example breakdowns are built in if you have nothing to hand. The
              document itself never leaves the phone; only the parsed shot list is sent, and only to
              write the tap chips.
            </p>
            <p className="gnote">
              iPhone footage shares its counter with the photo roll, so numbers skip and cannot be
              predicted. Set the start from real footage and expect to correct a number during the
              day.
            </p>
          </section>

          {/* 3 ---------------------------------------------------------- */}
          <section className="gsec" id="g-cams">
            <p className="gsec__num tnum">03</p>
            <h3 className="gsec__h">Running more than one camera</h3>
            <p className="gsec__lede">
              Pick 2 to 4 cameras in setup and each one becomes its own lettered unit, A to D.
            </p>
            <p>
              Every unit has its own clip counter, and it only advances when that camera rolls. Two
              identical cameras both writing <span className="tnum">C0001.MP4</span> is completely
              normal — the letter is what tells them apart on export, not the filename. Nobody has
              to rename anything.
            </p>
            <p>
              On export, each camera’s picture and sound land synced at the same point in the
              timeline, so the editor can start cutting between angles right away.
            </p>
            <p className="gnote">
              A tag you tap during a shot belongs to the take, not to one camera. It is saved on
              camera A’s clip.
            </p>
          </section>

          {/* 4 ---------------------------------------------------------- */}
          <section className="gsec" id="g-onset">
            <p className="gsec__num tnum">04</p>
            <h3 className="gsec__h">Rolling and cutting a shot</h3>
            <p className="gsec__lede">Open a scene, then roll.</p>
            <p>
              Tap the big <b>ROLL</b>. On a project with one camera and sound turned on, this rolls
              the camera and the recorder together.
            </p>
            <p>
              Prefer to start the recorder first? Roll it alone from the <b>SOUND</b> box — the
              camera joins the same shot the moment it rolls.
            </p>
            <p>
              Running more than one camera? Each one gets its own slot: tap a slot to roll that
              camera alone, tap <b>JOIN</b> to bring a camera into a shot already rolling, or tap a
              rolling camera to cut just that one. The shot ends once every camera and the recorder
              have all cut.
            </p>
            <p>
              The number on screen counts up while the shot rolls — it is the shot’s length, not the
              camera’s own on-screen clock (its timecode). Clapper cannot read that clock, so add it
              yourself at CUT if you want it on the record.
            </p>
            <p>
              While it rolls, tap what you see: <b>WIDE · MID · CU · OTS · INSERT</b> for coverage,{' '}
              <b>GOLD</b> for a keeper, PICKUP and NOISE for the rest. <b>MARK IN</b> then{' '}
              <b>MARK OUT</b> flags a stretch instead of one instant. Uploaded a shotlist? Shotlist mode
              swaps these for chips built from that scene instead, so you are tapping “door slams”
              and “she turns” rather than generic coverage.
            </p>
            <p>
              Hit <b>CUT</b> to close it. Clapper stamps the clip number(s), then asks you to Keep or
              Discard, with room for the camera’s timecode and a one-line note if you want them.
            </p>
            <p>
              Shoot scenes in any order you like. A <span className="gdot gdot--done" /> green dot
              marks a scene already in the can, a <span className="gdot" /> dim dot marks what is
              left, and the header keeps a running “X / Y in the can”.
            </p>
            <p className="gnote">
              The screen stays awake the whole time a scene is open, so it will not lock between
              takes.
            </p>
          </section>

          {/* 5 ---------------------------------------------------------- */}
          <section className="gsec" id="g-status">
            <p className="gsec__num tnum">05</p>
            <h3 className="gsec__h">Discard is not delete</h3>
            <p className="gsec__lede">
              One question sorts it: is there a file on the card? If yes, discard it. If no, delete
              it.
            </p>
            <div className="gsplit">
              <div className="gsplit__half">
                <p className="gsplit__k gsplit__k--keep">Discard</p>
                <p>
                  There is a file. The camera rolled and wrote it, the take was just no good. It
                  keeps its clip number, prints on the PDF struck through in the discarded list, and
                  still reaches the editor in the export, parked behind the good takes.
                </p>
                <p>Use it for a flubbed take, a false start, a roll nobody meant to make.</p>
              </div>
              <div className="gsplit__half">
                <p className="gsplit__k gsplit__k--kill">Delete</p>
                <p>
                  There is no file. You logged something that never happened: a double tap, the same
                  shot twice. Delete removes the row.
                </p>
                <p>
                  Clapper reclaims its clip number automatically: every later shot on that camera —
                  and the sound file, if it rolled — slides down by one to match.
                </p>
              </div>
            </div>
            <p className="gnote">
              Go by the card, not by memory. Discard something the camera never actually wrote and
              every number after it is off by one. Delete something it did write and that clip
              vanishes from the report without a trace.
            </p>
          </section>

          {/* 6 ---------------------------------------------------------- */}
          <section className="gsec" id="g-fix">
            <p className="gsec__num tnum">06</p>
            <h3 className="gsec__h">When a number goes wrong</h3>
            <p>
              Tap any shot to open it. It has its own stepper for the camera clip number and, if
              sound rolled on it, a separate stepper for the sound file number — fix whichever is
              wrong.
            </p>
            <p>
              Clapper shifts every <b>later</b> shot on that same camera or recorder by the same
              amount, and moves its live counter with it, because the camera or recorder kept
              counting while the log was wrong. It shows you exactly how many shots are about to
              change and asks you to confirm first — press <b>STOP</b> if that is not what you
              meant. Earlier shots never move.
            </p>
            <p>
              It shifts the numbers rather than renumbering from scratch, so a deliberate gap — a
              stretch where the camera rolled and you did not log it — survives instead of getting
              closed up.
            </p>
            <p>
              Fixing one camera never touches another. And you do not have to wait for a mistake:
              tap the pencil on any camera or on the sound box before you roll, to fix its next
              number in advance.
            </p>
          </section>

          {/* 7 ---------------------------------------------------------- */}
          <section className="gsec" id="g-scenes">
            <p className="gsec__num tnum">07</p>
            <h3 className="gsec__h">Scenes and shooting order</h3>
            <p className="gsec__lede">
              Add every scene before you shoot, then drag them into the order you will actually
              shoot in.
            </p>
            <p>
              Story order — the order scenes were written in — never changes once you set it.
              Shooting order is separate: drag a scene up or down the list to match your call sheet
              for the day.
            </p>
            <p>
              This matters at export. The editor’s timeline always follows story order, so
              reordering your on-set list to shoot scene 12 before scene 3 never scrambles the final
              cut.
            </p>
          </section>

          {/* 8 ---------------------------------------------------------- */}
          <section className="gsec" id="g-voice">
            <p className="gsec__num tnum">08</p>
            <h3 className="gsec__h">Voice, when your hands are full</h3>
            <p>
              Tap the mic on the roll screen and Clapper listens for the call. It appears only on
              browsers that support speech recognition.
            </p>
            <dl className="gsay">
              <dt>Starts a shot</dt>
              <dd>“roll” · “rolling” · “roll camera” · “camera roll”</dd>
              <dt>Stops it</dt>
              <dd>“cut” · “cut it”</dd>
            </dl>
            <p className="gnote">
              It matches the word anywhere in the sentence. While a shot is rolling, someone saying
              “cut” in conversation will stop it. Turn the mic off if the room talks over takes.
            </p>
          </section>

          {/* 9 ---------------------------------------------------------- */}
          <section className="gsec" id="g-out">
            <p className="gsec__num tnum">09</p>
            <h3 className="gsec__h">Handing off at wrap</h3>
            <p className="gsec__lede">
              Four export formats, all built from the same shot log.
            </p>
            <dl className="gsay gsay--wide">
              <dt>Premiere (XML)</dt>
              <dd>
                Opens as one timeline: the good takes cut together in story order, then a gap, then
                every take again — rejects included — in the same order, parked behind it. Every tap
                you made on set arrives as a marker on the clip it happened in.
              </dd>
              <dt>DaVinci Resolve (XML)</dt>
              <dd>The same timeline, built for Resolve instead of Premiere.</dd>
              <dt>PDF shot log</dt>
              <dd>
                For production and the director: scenes, shots, clip numbers, durations, camera
                timecode and wall clock, a GOLD summary up front and the discarded shots at the back.
              </dd>
              <dt>CSV</dt>
              <dd>
                For anyone who wants the raw data. One row per tapped moment, plus a row per take so
                takes with no tapped moments still appear.
              </dd>
            </dl>
            <p>
              Every camera’s clip lands on its own synced picture track, and the sound recorder’s
              file lands on the audio track under it, already lined up — the editor relinks the
              recorder’s file and it sits in sync under the picture, no manual reconciling.
              Multi-camera projects export the same way, with every camera’s angle stacked in sync
              at each position.
            </p>
            {/* RELOCATED from the top of every project screen, where it ran on
                every visit whether or not anything could be done about it. */}
            <p>
              <b>Back it up.</b> Signed out, a project exists on this phone and nowhere else: lose
              the phone and you lose the shoot. <b>Backup</b> in the export bar writes a file you
              can mail yourself, and <b>Settings › Restore from backup</b> stands it back up. Signed
              in, the same work syncs on its own. The Account tab says which of the two you are on.
            </p>
            <p className="gnote">
              PDF export works offline, no account needed. Premiere, Resolve and CSV need a quick,
              free Google sign-in, same for uploading a shotlist.
            </p>
          </section>

          <div className="rail rail--thin guide__tail" aria-hidden="true" />

          <button type="button" className="btn btn--go btn--full" onClick={onClose}>
            Back to settings
          </button>
        </div>
      </div>
    </div>
  );
}
