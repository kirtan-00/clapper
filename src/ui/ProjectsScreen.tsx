import { useEffect, useState } from 'react';
import type { Fps, Project } from '../types';
import { store } from '../store';
import { Sheet, Confirm, Rail } from './common';
import * as haptics from './haptics';

const FPS_OPTIONS: Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const DEFAULT_TAGS = ['FLUB', 'GOLD', 'PICKUP', 'NOISE'];

interface Row {
  project: Project;
  takeCount: number;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function ProjectsScreen(props: { onOpen: (project: Project) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);

  async function refresh() {
    const projects = await store.listProjects();
    projects.sort((a, b) => b.createdAt - a.createdAt);
    const withCounts = await Promise.all(
      projects.map(async (project) => {
        const bundle = await store.getBundle(project.id);
        return { project, takeCount: bundle.takes.length };
      }),
    );
    setRows(withCounts);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div>
          <h1>Clapper</h1>
          <p>On-set take log</p>
        </div>
      </header>

      {rows === null ? (
        <div className="empty">Loading projects</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <b>No projects yet</b>
          Start one for your shoot day. Set the frame rate and clip numbering once, then just
          roll.
        </div>
      ) : (
        <div className="stack">
          {rows.map(({ project, takeCount }) => (
            <button
              key={project.id}
              type="button"
              className="card"
              onClick={() => props.onOpen(project)}
            >
              <div className="card__row">
                <span className="card__name">{project.name}</span>
                <span className="card__count">{takeCount}</span>
              </div>
              <div className="card__meta">
                <span>{fmtDate(project.createdAt)}</span>
                <span>
                  <b>{project.fps}</b> fps
                </span>
                <span>
                  {takeCount === 1 ? '1 take' : `${takeCount} takes`}
                </span>
                <span
                  className="iconbtn"
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete ${project.name}`}
                  style={{ marginLeft: 'auto', minHeight: 32, minWidth: 32 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleting(project);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      setDeleting(project);
                    }
                  }}
                >
                  del
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className="newproject"
        onClick={() => {
          haptics.tap();
          setCreating(true);
        }}
      >
        <span aria-hidden="true">+</span> New project
      </button>

      <div style={{ marginTop: 22 }}>
        <Rail thin />
      </div>

      {creating && (
        <CreateProjectSheet
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            props.onOpen(project);
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          message="This removes the project and every slate, take, and moment in it. This cannot be undone."
          confirmLabel="Delete project"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await store.deleteProject(deleting.id);
            setDeleting(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateProjectSheet(props: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [fps, setFps] = useState<Fps>(24);
  const [prefix, setPrefix] = useState('C');
  const [startNumber, setStartNumber] = useState('1');
  const [padding, setPadding] = useState('4');
  const [tags, setTags] = useState<string[]>(DEFAULT_TAGS);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const canCreate = name.trim().length > 0 && !busy;

  function addTag() {
    const t = tagDraft.trim().toUpperCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  }

  async function create() {
    if (!canCreate) return;
    setBusy(true);
    const project = await store.createProject({
      name: name.trim(),
      fps,
      clipPrefix: prefix,
      nextClipNumber: Math.max(0, parseInt(startNumber, 10) || 0),
      clipPadding: Math.min(8, Math.max(1, parseInt(padding, 10) || 4)),
      tags,
    });
    props.onCreated(project);
  }

  return (
    <Sheet title="New project" onClose={props.onClose}>
      <div className="formrow">
        <label className="label" htmlFor="np-name">
          Project name
        </label>
        <input
          id="np-name"
          className="field"
          value={name}
          autoFocus
          placeholder="Day 3 - Interior Cafe"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="formgrid">
        <div className="formrow">
          <label className="label" htmlFor="np-fps">
            Frame rate
          </label>
          <select
            id="np-fps"
            className="field"
            value={fps}
            onChange={(e) => setFps(parseFloat(e.target.value) as Fps)}
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
        <div className="formrow">
          <label className="label" htmlFor="np-prefix">
            Clip prefix
          </label>
          <input
            id="np-prefix"
            className="field field--mono"
            value={prefix}
            placeholder="C"
            onChange={(e) => setPrefix(e.target.value)}
          />
        </div>
      </div>

      <div className="formgrid">
        <div className="formrow">
          <label className="label" htmlFor="np-start">
            Starting clip no.
          </label>
          <input
            id="np-start"
            className="field field--mono"
            inputMode="numeric"
            value={startNumber}
            onChange={(e) => setStartNumber(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="formrow">
          <label className="label" htmlFor="np-pad">
            Number padding
          </label>
          <input
            id="np-pad"
            className="field field--mono"
            inputMode="numeric"
            value={padding}
            onChange={(e) => setPadding(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
      </div>

      <div className="formrow">
        <span className="label">Quick tags</span>
        <div className="chips">
          {tags.map((t) => (
            <span key={t} className={`chip chip--removable${t === 'GOLD' ? ' chip--gold' : ''}`}>
              {t}
              <button
                type="button"
                className="chip__x"
                aria-label={`Remove tag ${t}`}
                onClick={() => setTags(tags.filter((x) => x !== t))}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
        <div className="addline">
          <input
            className="field field--mono"
            value={tagDraft}
            placeholder="Add tag"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <button type="button" className="btn" onClick={addTag}>
            Add
          </button>
        </div>
      </div>

      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" disabled={!canCreate} onClick={create}>
          Create project
        </button>
      </div>
    </Sheet>
  );
}
