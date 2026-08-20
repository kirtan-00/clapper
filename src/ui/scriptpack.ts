// Script Mode — the bridge from a screenplay to Clapper's model.
//
// A "script pack" is the structured breakdown a session LLM (Claude, offline —
// no runtime API in the app) produces from a script: one pack per film, each
// scene carrying a plain-language summary and two tiers of tap chips. Importing
// a pack spins up a Project with one Slate per scene, pre-loaded with chips, so
// on set the operator does nothing but tap. The app only ever READS packs; it
// never calls a model.

import type { Project, Shot, SlateTag } from '../types';
import { store } from '../store';
import { newId } from '../store/util';
// Hand-built in a Claude session to the shape a real shotlist parse produces:
// every setup carries a size and move column, so those stay populated here too,
// unlike the sibling pack below where the source document had neither.
import keepTheTake from './packs/keep-the-take.json';
// Hand-built from a revised breakdown PDF in a Claude session, not parsed: the
// source table carries no shot-size or camera-move column, so those stay absent
// rather than being guessed at on the crew's behalf.
import aRoomThatRemembers from './packs/no-mans-hero.json';

/**
 * One setup inside a pack scene. Present when the source document was a
 * SHOTLIST (a numbered table of setups) rather than a prose screenplay —
 * either read straight off the table by `shotlist.ts` or, for a screenplay,
 * proposed by the model. Absent means the scene logs takes directly, exactly
 * as Script Mode has always worked.
 */
export interface ScriptPackShot {
  code: string;             // "5.31" — as printed on the shotlist
  order: number;            // position within the scene
  size?: string;            // "MCU", "XWS", "OTS (over Dev)"
  move?: string;            // "STATIC, low", "Slow PUSH IN"
  action?: string;          // one-line recognizer for the operator
  dialogue?: string;        // the line, when the shotlist carries one
  note?: string;            // the shotlist's NOTES column
  /**
   * Tappable beats INSIDE this one shot, added by the model from the parsed
   * shot division. Often empty — most setups are a single action with nothing
   * to mark mid-take — and empty is the right answer there, not a failure.
   */
  keyMoments?: string[];
}

export interface ScriptPackScene {
  scriptRef: string;        // "SC 1", "GF-2"… stable id for grouping/sorting
  name: string;             // slate name shown on set
  summary: string;          // one-line recognizer
  order: number;            // scene order within the film
  coverageTags?: string[];  // defaults to pack.project.coverageTags if omitted
  keyMomentTags: string[];  // script-derived beats (clamped to 6 on import)
  shots?: ScriptPackShot[]; // the scene's setups, when the source had them
}

export interface ScriptPack {
  clapperScriptPack: 1;
  project: {
    name: string;
    coverageTags: string[];
  };
  scenes: ScriptPackScene[];
}

const MAX_KEY_MOMENTS = 6;
// A feature-length scene tops out well under this; the cap exists so a
// misparsed table can't spray thousands of rows into one scene record.
const MAX_SHOTS = 200;
// A single setup is a few seconds long. More than three things to tap inside it
// is noise on a phone held at arm's length.
const MAX_SHOT_MOMENTS = 3;

function isPack(x: unknown): x is ScriptPack {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return (
    p.clapperScriptPack === 1 &&
    typeof p.project === 'object' &&
    p.project !== null &&
    Array.isArray((p as { scenes?: unknown }).scenes)
  );
}

/** Parse pasted/loaded JSON into a validated pack, or throw with a clear why. */
export function parseScriptPack(text: string): ScriptPack {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  if (!isPack(data)) {
    throw new Error('Not a Clapper script pack (need clapperScriptPack: 1, project, scenes[]).');
  }
  return data;
}

function tagsForScene(scene: ScriptPackScene, fallbackCoverage: string[]): SlateTag[] {
  const tags: SlateTag[] = [];
  const coverage = scene.coverageTags && scene.coverageTags.length ? scene.coverageTags : fallbackCoverage;
  coverage.forEach((label, i) => tags.push({ id: newId(), label, tier: 'coverage', order: i }));
  scene.keyMomentTags.slice(0, MAX_KEY_MOMENTS).forEach((label, i) =>
    tags.push({ id: newId(), label, tier: 'keyMoment', order: i }),
  );
  return tags;
}

type ProjectCreate = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Create one Project (a film) with one Slate per scene, chips loaded. Pass
 * `overrides` to set the camera/clip/fps details the user chose after upload;
 * anything omitted falls back to sensible Script Mode defaults.
 */
export async function importScriptPack(
  pack: ScriptPack,
  overrides: Partial<ProjectCreate> = {},
): Promise<Project> {
  const project = await store.createProject({
    name: pack.project.name,
    fps: 24,
    camera: 'sony',
    clipPrefix: 'C',
    clipSuffix: '',
    clipExt: '.MP4',
    nextClipNumber: 1,
    clipPadding: 4,
    tags: ['GOLD', 'FLUB', 'PICKUP', 'NOISE'],
    ...overrides,
  });

  const scenes = [...pack.scenes].sort((a, b) => a.order - b.order);
  for (const scene of scenes) {
    const slate = await store.createSlate(project.id, scene.name);
    await store.updateSlate(slate.id, {
      summary: scene.summary,
      scriptRef: scene.scriptRef,
      tags: tagsForScene(scene, pack.project.coverageTags),
      shots: shotsForScene(scene),
    });
  }
  return project;
}

/**
 * Materialise a scene's setups. Returns undefined when the pack carries none,
 * so the scene stays a plain take-logging scene and every legacy code path
 * runs untouched.
 */
function shotsForScene(scene: ScriptPackScene): Shot[] | undefined {
  if (!scene.shots || !scene.shots.length) return undefined;
  return [...scene.shots]
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_SHOTS)
    .map((s, i) => ({
      id: newId(),
      code: String(s.code || `${scene.order}.${i + 1}`).slice(0, 12),
      order: i + 1,
      size: s.size?.slice(0, 24) || undefined,
      move: s.move?.slice(0, 40) || undefined,
      action: s.action?.slice(0, 160) || undefined,
      dialogue: s.dialogue?.slice(0, 200) || undefined,
      note: s.note?.slice(0, 120) || undefined,
      tags: keyMomentTags(s.keyMoments),
    }));
}

/** The shot's own chips. Undefined when the model found nothing worth tapping. */
function keyMomentTags(labels: string[] | undefined): SlateTag[] | undefined {
  if (!labels || !labels.length) return undefined;
  const tags = labels
    .filter((l) => typeof l === 'string' && l.trim())
    .slice(0, MAX_SHOT_MOMENTS)
    .map((label, i) => ({ id: newId(), label: label.trim().slice(0, 40), tier: 'keyMoment' as const, order: i }));
  return tags.length ? tags : undefined;
}

// ---------------------------------------------------------------------------
// Treeland campaign — the demo. Five ad films, broken down scene by scene by
// Claude from the real shooting scripts. Every key-moment chip is a beat the
// editor will want flagged in the take.
//
// Coverage is the same three keys everywhere — see COVERAGE_KEYS in shotlist.ts
// for why. These aliases stay so each scene still reads as the kind of scene it
// is, and so a future per-scene pad is a one-line change.
// ---------------------------------------------------------------------------

const DIALOG: string[] = ['WIDE', 'MID', 'CLOSEUP'];
const ACTION: string[] = DIALOG;
const BEAUTY: string[] = DIALOG;

export const TREELAND_DEMO: ScriptPack[] = [
  {
    clapperScriptPack: 1,
    project: { name: 'Treeland · GrandFather', coverageTags: DIALOG },
    scenes: [
      {
        scriptRef: 'GF-1', order: 1, coverageTags: ACTION,
        name: 'GF 1 · INT. BEDROOM · MORNING',
        summary: 'Father wakes in the new home, stops the alarm, walks out past the family photos.',
        keyMomentTags: ['alarm stops', 'stretch / wake', 'face in photo reflection', 'walk to kitchen'],
      },
      {
        scriptRef: 'GF-2', order: 2, coverageTags: ACTION,
        name: 'GF 2 · INT. KITCHEN · MORNING',
        summary: 'He quietly makes coffee, alone in the quiet house.',
        keyMomentTags: ['makes coffee', 'first sip', 'alone beat'],
      },
      {
        scriptRef: 'GF-3', order: 3, coverageTags: ACTION,
        name: 'GF 3 · EXT. BALCONY · MORNING',
        summary: 'Sips coffee watching the view; spots a yoga mat beside him and picks it up.',
        keyMomentTags: ['watching the view', 'spots yoga mat', 'picks up mat'],
      },
      {
        scriptRef: 'GF-4', order: 4,
        name: 'GF 4 · EXT. GARDEN · DAY (yoga + resident)',
        summary: 'Doing yoga in the garden; a resident greets him, learns he is new, offers a tour.',
        keyMomentTags: ['yoga pose', 'resident enters', '“naye aaye ho” line', 'warm handshake'],
      },
      {
        scriptRef: 'GF-5', order: 5, coverageTags: BEAUTY,
        name: 'GF 5 · EXT. TREELAND · DAY (tour montage)',
        summary: 'Resident tours him around Treeland; welcomed into a group, his hesitation melts.',
        keyMomentTags: ['tour walk', 'meets the group', 'laughter / welcome', 'hesitation melts'],
      },
      {
        scriptRef: 'GF-6', order: 6,
        name: 'GF 6 · INT. KITCHEN · DAY 20 (friends)',
        summary: 'Day 20: coffee ritual interrupted by the doorbell; friends burst in with banter.',
        keyMomentTags: ['doorbell', 'friends burst in', 'banter lines', '“2 min me laaya”', 'mugs clink'],
      },
      {
        scriptRef: 'GF-7', order: 7, coverageTags: BEAUTY,
        name: 'GF 7 · TAGLINE CARD',
        summary: 'Screen blurs to the Treeland tagline.',
        keyMomentTags: ['tagline card'],
      },
    ],
  },
  {
    clapperScriptPack: 1,
    project: { name: 'Treeland · Classroom', coverageTags: DIALOG },
    scenes: [
      {
        scriptRef: 'CL-1', order: 1,
        name: 'CL 1 · INT. ART ROOM · DAY (wide)',
        summary: 'Bright art room, kids at desks. Teacher: “today we draw our house.”',
        keyMomentTags: ['room pan', 'teacher line', 'class starts drawing'],
      },
      {
        scriptRef: 'CL-2', order: 2, coverageTags: ACTION,
        name: 'CL 2 · INSERTS · kids drawing',
        summary: 'Kids draw homes, gardens, pets; Aarav adds mountains, a river, a rising sun, birds.',
        keyMomentTags: ['other kids drawing', 'Aarav: mountains + river', 'rising sun', 'birds in sky'],
      },
      {
        scriptRef: 'CL-3', order: 3,
        name: 'CL 3 · INT. ART ROOM · teacher notices',
        summary: 'Teacher walks the room, notices Aarav: “par kya ghar aise hote hai?”',
        keyMomentTags: ['teacher walks', 'reaches Aarav', '“kya ghar aise hote hai” line'],
      },
      {
        scriptRef: 'CL-4', order: 4,
        name: 'CL 4 · CU · Aarav replies',
        summary: 'CU on the drawing, kids curious. Aarav: “mera ghar toh aisa hi hai, ma’am.”',
        keyMomentTags: ['drawing CU', 'kids lean in', '“mera ghar aisa hi hai” line'],
      },
      {
        scriptRef: 'CL-5', order: 5, coverageTags: BEAUTY,
        name: 'CL 5 · EXT. TREELAND · reveal',
        summary: 'Classroom fades to a panorama of Treeland that mirrors Aarav’s drawing.',
        keyMomentTags: ['classroom fade', 'Treeland reveal', 'amenities pan'],
      },
      {
        scriptRef: 'CL-6', order: 6, coverageTags: BEAUTY,
        name: 'CL 6 · LOGO / TAGLINE',
        summary: 'End on the Treeland logo and contact over the community view.',
        keyMomentTags: ['logo + contact', 'tagline card'],
      },
    ],
  },
  {
    clapperScriptPack: 1,
    project: { name: 'Treeland · Tennis', coverageTags: DIALOG },
    scenes: [
      {
        scriptRef: 'TN-1', order: 1, coverageTags: ACTION,
        name: 'TN 1 · INT. LIVING ROOM · DAY (unpacking)',
        summary: 'Anjali unpacks boxes; opens “Memories”, finds a tennis racket, drifts into thought.',
        keyMomentTags: ['unpacking boxes', 'opens Memories box', 'finds racket', 'lost in thought'],
      },
      {
        scriptRef: 'TN-2', order: 2, coverageTags: BEAUTY,
        name: 'TN 2 · FLASHBACK · tennis court',
        summary: 'Flashback: Anjali laughing, teaching kids lawn tennis, in her element.',
        keyMomentTags: ['flashback in', 'teaching kids', 'laughing / rally'],
      },
      {
        scriptRef: 'TN-3', order: 3,
        name: 'TN 3 · INT. LIVING ROOM · Rohan',
        summary: 'Rohan enters, notices the racket and her look, nudges her to play again.',
        keyMomentTags: ['Rohan enters', 'notices racket', '“firse start kyu nahi” line', '“dekhti hu” reply'],
      },
      {
        scriptRef: 'TN-4', order: 4, coverageTags: ACTION,
        name: 'TN 4 · EXT. TENNIS AREA · DAY (return)',
        summary: 'In sports gear, hesitant, she hits against the wall; days pass, skill and joy return.',
        keyMomentTags: ['hesitant entry', 'first hit on wall', 'joy returns', 'days montage', 'teaching kids'],
      },
      {
        scriptRef: 'TN-5', order: 5, coverageTags: BEAUTY,
        name: 'TN 5 · EXT. COURT · SUNSET',
        summary: 'Golden hour: surrounded by kids, high-fives, freeze on her joyful face.',
        keyMomentTags: ['sunset court', 'high-fives', 'freeze on face'],
      },
    ],
  },
  {
    clapperScriptPack: 1,
    project: { name: 'Treeland · Resort Retreat', coverageTags: DIALOG },
    scenes: [
      {
        scriptRef: 'RR-1', order: 1,
        name: 'RR 1 · EXT. PARK BENCH · DAY (Aanya + Riya)',
        summary: 'Girls cycle, then sit by the river. Aanya gushes about a 5-star resort.',
        keyMomentTags: ['cycling in', 'sit on bench', '“vacation” excited line'],
      },
      {
        scriptRef: 'RR-2', order: 2, coverageTags: BEAUTY,
        name: 'RR 2 · OVERLAY · resort dream',
        summary: 'Dreamy overlay of Aanya at the resort: wooden walkway wrapped in nature.',
        keyMomentTags: ['dreamy overlay', 'wooden walkway', 'nature beauty'],
      },
      {
        scriptRef: 'RR-3', order: 3, coverageTags: BEAUTY,
        name: 'RR 3 · IMAGINE · riverside jog',
        summary: 'Transition to Riya jogging beside the serene Treeland river.',
        keyMomentTags: ['transition to Treeland', 'jogging path', 'riverside'],
      },
      {
        scriptRef: 'RR-4', order: 4, coverageTags: BEAUTY,
        name: 'RR 4 · IMAGINE · sports amenities',
        summary: 'Riya enjoying Treeland sports: tennis, pool, top-notch facilities.',
        keyMomentTags: ['tennis court', 'swimming pool', 'sports facilities'],
      },
      {
        scriptRef: 'RR-5', order: 5, coverageTags: BEAUTY,
        name: 'RR 5 · IMAGINE · luxury montage',
        summary: 'Riya daydreams through Treeland luxury: clubhouse, pool, exclusive areas.',
        keyMomentTags: ['clubhouse', 'pool', 'exclusive areas', 'daydream face'],
      },
      {
        scriptRef: 'RR-6', order: 6,
        name: 'RR 6 · EXT. BENCH · punchline',
        summary: 'Riya: “yeh sab ghar pe bhi kar sakti thi.” Aanya shocked; friends gather.',
        keyMomentTags: ['Riya punchline', 'Aanya shocked', 'friends gather'],
      },
      {
        scriptRef: 'RR-7', order: 7, coverageTags: BEAUTY,
        name: 'RR 7 · TREELAND WIDE + LOGO',
        summary: 'Wide of green riverside Treeland; end on logo, contact and tagline.',
        keyMomentTags: ['Treeland wide', 'logo + contact', 'tagline card'],
      },
    ],
  },
  {
    clapperScriptPack: 1,
    project: { name: 'Treeland · A Happy Dog', coverageTags: DIALOG },
    scenes: [
      {
        scriptRef: 'HD-1', order: 1,
        name: 'HD 1 · EXT. BENCHES · DAY (setup)',
        summary: 'Two people on a bench, dogs on the next benches. “Oyee, shhh, sun na”, then focus shifts to the dog.',
        keyMomentTags: ['people on bench', '“oyee sun na” voice', 'focus shift to dog'],
      },
      {
        scriptRef: 'HD-2', order: 2,
        name: 'HD 2 · CU · dogs talking',
        summary: 'The dogs chat: 3-day gap, the annoying leash, one is tired from the pet park; Dog 2 goes sad.',
        keyMomentTags: ['Dog 1 line', 'Dog 2 leash gripe', '“pet park se aaya”', 'Dog 2 shocked / sad'],
      },
      {
        scriptRef: 'HD-3', order: 3, coverageTags: BEAUTY,
        name: 'HD 3 · EXT. PET PARK · amenity',
        summary: 'Serene pet-park footage, dogs playing and having fun.',
        keyMomentTags: ['pet park wide', 'pets playing', 'happy dog beat'],
      },
      {
        scriptRef: 'HD-4', order: 4, coverageTags: BEAUTY,
        name: 'HD 4 · LOGO / TAGLINE',
        summary: 'Fade to the Treeland logo with the tagline.',
        keyMomentTags: ['logo', 'tagline card'],
      },
    ],
  },
];

/** Import every demo film. Returns the created projects (films). */
export async function importTreelandDemo(): Promise<Project[]> {
  const out: Project[] = [];
  for (const pack of TREELAND_DEMO) out.push(await importScriptPack(pack));
  return out;
}

// The two example breakdowns Script Mode offers as a try-it. Bundled, so they
// need no account, no upload and no network — which also makes them the way to
// put a real shot division on a borrowed device.
//
// The second one is a whole short film rather than an ad: 5 scenes, 137 shots,
// 120 of them carrying key-moment chips. It is the only example that shows the
// Scene > Shot > Take hierarchy at the scale a real shoot has, where a scene is
// 47 setups deep and picking the shot matters.
// The cast just tells TypeScript the JSON already matches ScriptPack, since a
// JSON import widens every literal to string.
const KEEP_THE_TAKE = keepTheTake as unknown as ScriptPack;
// Same cast, same reason — a JSON import widens every literal to string.
const A_ROOM_THAT_REMEMBERS = aRoomThatRemembers as unknown as ScriptPack;

export const EXAMPLE_PACKS: { key: string; label: string; blurb: string; pack: ScriptPack }[] = [
  // First, because it is the fullest Scene > Shot > Take demo at ordinary
  // scale: an operator opens the app and the top demo is a complete shoot,
  // not an ad's handful of setups.
  {
    key: 'roomremembers',
    label: "No Man's Hero",
    blurb: 'Short film · 10 scenes · 76 shots',
    pack: A_ROOM_THAT_REMEMBERS,
  },
  { key: 'grandfather', label: 'Grandfather ad', blurb: 'Family / lifestyle spot · 7 scenes', pack: TREELAND_DEMO[0] },
  {
    key: 'keepthetake',
    label: 'Keep The Take',
    blurb: 'Short film · 5 scenes · 137 shots',
    pack: KEEP_THE_TAKE,
  },
];
