// Script Mode — the bridge from a screenplay to Clapper's model.
//
// A "script pack" is the structured breakdown a session LLM (Claude, offline —
// no runtime API in the app) produces from a script: one pack per film, each
// scene carrying a plain-language summary and two tiers of tap chips. Importing
// a pack spins up a Project with one Slate per scene, pre-loaded with chips, so
// on set the operator does nothing but tap. The app only ever READS packs; it
// never calls a model.

import type { Project, SlateTag } from '../types';
import { store } from '../store';
import { newId } from '../store/util';

export interface ScriptPackScene {
  scriptRef: string;        // "SC 1", "GF-2"… stable id for grouping/sorting
  name: string;             // slate name shown on set
  summary: string;          // one-line recognizer
  order: number;            // scene order within the film
  coverageTags?: string[];  // defaults to pack.project.coverageTags if omitted
  keyMomentTags: string[];  // script-derived beats (clamped to 6 on import)
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
    });
  }
  return project;
}

// ---------------------------------------------------------------------------
// Treeland campaign — the demo. Five ad films, broken down scene by scene by
// Claude from the real shooting scripts. Coverage is pruned per scene; every
// key-moment chip is a beat the editor will want flagged in the take.
// ---------------------------------------------------------------------------

const DIALOG: string[] = ['WIDE', 'MID', 'CU', 'OTS'];
const ACTION: string[] = ['WIDE', 'MID', 'CU', 'INSERT'];
const BEAUTY: string[] = ['WIDE', 'MID', 'INSERT'];

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

// The two example breakdowns Script Mode offers as a try-it (no email needed):
// a people/family ad and a school ad. Both are real Treeland scripts already
// broken down, so a user can feel the on-set flow before uploading their own.
export const EXAMPLE_PACKS: { key: string; label: string; blurb: string; pack: ScriptPack }[] = [
  { key: 'grandfather', label: 'Grandfather ad', blurb: 'Family / lifestyle spot · 7 scenes', pack: TREELAND_DEMO[0] },
  { key: 'school', label: 'School ad', blurb: 'Classroom story spot · 6 scenes', pack: TREELAND_DEMO[1] },
];
