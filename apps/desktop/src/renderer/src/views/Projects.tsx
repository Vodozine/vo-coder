import { useEffect, useMemo, useState } from 'react';
import {
  answer,
  back,
  current,
  ENV_QUESTION_IDS,
  progress,
  seedAnswers,
  start,
  toAnswers,
  type QuestionnaireState,
} from '@vo-coder/scaffold/core';
import type { Detection, InjectResult } from '@vo-coder/scaffold';
import { HOMELAB_PROJECT_ID } from '../../../shared/homelab';
import { Icon } from '../components/Icon';
import { isDesignSessionMeta, isHomelabSessionMeta, useStore } from '../state/store';

const STATE_LABEL: Record<Detection['state'], string> = {
  new: 'New folder — full scaffold will be injected.',
  existing: 'Existing project — only missing files will be written, nothing overwritten.',
  managed: 'Already managed by Vo-Coder — regenerating needs Force.',
};

/** One card per project — the overview that replaces hunting in the sidebar. */
function fmtWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

type Mode = 'overview' | 'create';
type Step = 'folder' | 'type' | 'coding' | 'describe' | 'result';
type Kind = 'coding' | 'other';

export function Projects() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const projects = useStore((s) => s.projects);
  const sessionMetas = useStore((s) => s.sessionMetas);
  const consumeScaffoldTarget = useStore((s) => s.consumeScaffoldTarget);
  const openProject = useStore((s) => s.openProject);
  const attachProjectForFolder = useStore((s) => s.attachProjectForFolder);
  const startSimpleProject = useStore((s) => s.startSimpleProject);

  const [mode, setMode] = useState<Mode>('overview');
  const [step, setStep] = useState<Step>('folder');
  const [kind, setKind] = useState<Kind>('coding');

  const [dir, setDir] = useState<string | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [qState, setQState] = useState<QuestionnaireState>(start());
  const [seeded, setSeeded] = useState<string[]>([]);
  const [textValue, setTextValue] = useState('');
  const [description, setDescription] = useState('');
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<InjectResult | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startQuestionnaire = (defaults: Record<string, string>) => {
    const state = seedAnswers(start(), defaults, ENV_QUESTION_IDS);
    setQState(state);
    setSeeded(ENV_QUESTION_IDS.filter((id) => id in state.answers));
  };

  const resetCreate = () => {
    setDir(null);
    setDetection(null);
    setQState(start());
    setSeeded([]);
    setTextValue('');
    setDescription('');
    setForce(false);
    setResult(null);
    setCreatedProjectId(null);
    setError(null);
    setKind('coding');
  };

  // Adopt a folder into the create flow: detect its state, seed the usual
  // environment answers, and land on the Coding/Other choice.
  const target = async (picked: string) => {
    setDir(picked);
    setDetection(await window.vo.scaffoldDetect(picked));
    startQuestionnaire(useStore.getState().config?.scaffoldDefaults ?? {});
    setResult(null);
    setError(null);
    setMode('create');
    setStep('type');
  };

  const pickFolder = async () => {
    const picked = await window.vo.scaffoldPickDir();
    if (picked) await target(picked);
  };

  // A project freshly created from the sidebar hands its folder straight here.
  useEffect(() => {
    const handoff = consumeScaffoldTarget();
    if (handoff) void target(handoff);
  }, []);

  const newProject = () => {
    resetCreate();
    setMode('create');
    setStep('folder');
  };

  const backToOverview = () => {
    resetCreate();
    setMode('overview');
    setStep('folder');
  };

  const giveAnswer = (value: string) => {
    try {
      setQState(answer(qState, value));
      setTextValue('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Full coding setup: write PROJECT_CONFIG.md, then register the folder as a
  // project so it shows up in the overview and the sidebar.
  const generate = async () => {
    if (!dir) return;
    setBusy(true);
    try {
      const answers = toAnswers(qState);
      const res = await window.vo.scaffoldGenerate(dir, answers, force);
      setResult(res);
      const { project } = await attachProjectForFolder(dir);
      if (project) setCreatedProjectId(project.id);
      // Remember the environment answers so the next project skips those questions.
      if (config) {
        await saveConfig({
          scaffoldDefaults: {
            virtualization: answers.virtualization,
            ...(answers.hypervisorKind ? { hypervisorKind: answers.hypervisorKind } : {}),
            devOs: answers.devOs,
          },
        });
      }
      setStep('result');
    } finally {
      setBusy(false);
    }
  };

  // The "just describe and start" path — coding-skip or non-code alike.
  const createSimple = async () => {
    if (!dir || !description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const err = await startSimpleProject(dir, description);
      if (err) {
        setError(err);
        return;
      }
      backToOverview();
    } finally {
      setBusy(false);
    }
  };

  // ---- overview data ----
  const overview = useMemo(() => {
    const latest = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const m of sessionMetas) {
      if (isDesignSessionMeta(m) || isHomelabSessionMeta(m)) continue;
      counts.set(m.projectId, (counts.get(m.projectId) ?? 0) + 1);
      latest.set(m.projectId, Math.max(latest.get(m.projectId) ?? 0, m.updatedAt));
    }
    return projects
      .filter(
        (p) =>
          // (No Design suite in the Free edition — the id guard is enough.)
          p.id !== 'design_library' && p.id !== HOMELAB_PROJECT_ID,
      )
      .map((p) => ({
        project: p,
        chats: counts.get(p.id) ?? 0,
        when: latest.get(p.id) ?? p.createdAt,
      }))
      .sort((a, b) => b.when - a.when);
  }, [projects, sessionMetas]);

  const q = current(qState);
  const { done, total } = progress(qState);

  // The folder + detection banner, shown on every create step once a folder is set.
  const folderBar = dir && (
    <div className="create-folderbar">
      <Icon name="folder" size={13} />
      <span className="meta grow" title={dir}>
        {dir}
      </span>
      {detection && (
        <span className={`create-detect detect-${detection.state}`}>{detection.state}</span>
      )}
    </div>
  );

  if (mode === 'overview') {
    return (
      <div className="settings settings-full projects-view">
        <div className="projects-head-row">
          <h1>Projects</h1>
          <div className="projects-head-actions">
            <button className="send" onClick={newProject}>
              + New project
            </button>
          </div>
        </div>
        <p className="hint">
          Every project in one place — click one to jump back into its chats, or start a new one.
        </p>

        {overview.length === 0 ? (
          <div className="projects-empty">
            <p className="hint">No projects yet.</p>
            <button className="send" onClick={newProject}>
              + New project
            </button>
          </div>
        ) : (
          <div className="projects-grid">
            <button className="project-card project-card-new" onClick={newProject}>
              <span className="project-card-plus">+</span>
              <span className="project-card-name">New project</span>
              <span className="project-card-path">Coding or anything else</span>
            </button>
            {overview.map(({ project, chats, when }) => (
              <button
                key={project.id}
                className="project-card"
                onClick={() => void openProject(project.id)}
                title={project.dir ?? 'No folder — generic chats'}
              >
                <span className="project-card-name">{project.name}</span>
                <span className="project-card-path">
                  {project.dir ? (
                    <>
                      <Icon name="folder" size={11} /> {project.dir}
                    </>
                  ) : (
                    'No folder — generic chats'
                  )}
                </span>
                <span className="project-card-meta">
                  {chats === 1 ? '1 chat' : `${chats} chats`}
                  <span className="project-card-dot">·</span>
                  {fmtWhen(when)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- create flow ----
  return (
    <div className="settings settings-full projects-view">
      <div className="projects-head-row">
        <h1>New project</h1>
        <button className="ghost" onClick={backToOverview}>
          ← Projects
        </button>
      </div>

      {step === 'folder' && (
        <section>
          <h2>Project folder</h2>
          <p className="hint">Pick a folder — a new empty one, or an existing project.</p>
          <div className="field-row">
            <button className="send" onClick={() => void pickFolder()}>
              Choose folder…
            </button>
          </div>
        </section>
      )}

      {step === 'type' && (
        <section>
          {folderBar}
          <h2>What kind of project is this?</h2>
          <div className="type-choice">
            <button
              className="type-card"
              onClick={() => {
                setKind('coding');
                setStep('coding');
              }}
            >
              <Icon name="branch" size={22} />
              <span className="type-card-name">Coding project</span>
              <span className="type-card-desc">
                Runs the setup so the harness and infra tools know your stack. You can skip the
                questions and just describe it.
              </span>
            </button>
            <button
              className="type-card"
              onClick={() => {
                setKind('other');
                setDescription('');
                setStep('describe');
              }}
            >
              <Icon name="compass" size={22} />
              <span className="type-card-name">Other</span>
              <span className="type-card-desc">
                Anything that isn&apos;t code — research, writing, planning. Just a folder and a
                description.
              </span>
            </button>
          </div>
        </section>
      )}

      {step === 'coding' && (
        <section>
          {folderBar}
          {detection && (
            <p className={`hint detect-${detection.state}`}>{STATE_LABEL[detection.state]}</p>
          )}
          <div className="coding-head">
            <h2>
              Setup{' '}
              <span className="meta">
                {Math.min(done + 1, total)}/{total}
              </span>
            </h2>
            <button
              className="ghost"
              onClick={() => {
                setKind('coding');
                setStep('describe');
              }}
            >
              Skip — just describe it
            </button>
          </div>
          {detection?.state === 'managed' && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Force regenerate PROJECT_CONFIG.md
            </label>
          )}
          {seeded.length > 0 && (
            <div className="field-row seeded-note">
              <span className="hint grow">
                Using your usual environment —{' '}
                {seeded.map((id) => qState.answers[id]).filter(Boolean).join(', ')} — those
                questions are skipped.
              </span>
              <button
                className="ghost"
                onClick={() => {
                  setQState(start());
                  setSeeded([]);
                }}
              >
                Answer them again
              </button>
            </div>
          )}
          {q ? (
            <div className="wizard-question">
              <p className="wizard-prompt">{q.prompt}</p>
              {q.hint && <p className="hint">{q.hint}</p>}
              {(() => {
                // Beginners get every option explained; the skill question
                // itself always is — it's answered before we know who's asking.
                const explain =
                  q.id === 'skillLevel' || qState.answers.skillLevel === 'beginner';
                return (
                  <>
                    {explain && q.beginnerHint && (
                      <p className="hint wizard-beginner-hint">{q.beginnerHint}</p>
                    )}
                    {q.kind === 'select' ? (
                      <div className={`wizard-options ${explain ? 'explained' : ''}`}>
                        {q.options!.map((o) => (
                          <button key={o.value} onClick={() => giveAnswer(o.value)}>
                            {explain && o.description ? (
                              <>
                                <span className="wizard-option-label">{o.label}</span>
                                <span className="wizard-option-desc">{o.description}</span>
                              </>
                            ) : (
                              o.label
                            )}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                );
              })()}
              {q.kind !== 'select' && (
                <div className="field-row">
                  <input
                    className="grow"
                    value={textValue}
                    placeholder={q.optional ? '(optional — Enter to skip)' : ''}
                    autoFocus
                    onChange={(e) => setTextValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') giveAnswer(textValue);
                    }}
                  />
                  <button onClick={() => giveAnswer(textValue)}>Next</button>
                </div>
              )}
              {error && <p className="hint error-text">{error}</p>}
              {qState.answered.length > 0 && (
                <button className="ghost" onClick={() => setQState(back(qState))}>
                  ← Back
                </button>
              )}
            </div>
          ) : (
            <div>
              <div className="answer-review">
                {Object.entries(qState.answers).map(([k, v]) => (
                  <div key={k} className="field-row">
                    <label>{k}</label>
                    <span className="meta grow">{v || '—'}</span>
                  </div>
                ))}
              </div>
              <div className="modal-actions">
                <button className="ghost" onClick={() => setQState(back(qState))}>
                  ← Back
                </button>
                <button className="send" disabled={busy} onClick={() => void generate()}>
                  {busy ? 'Generating…' : 'Generate PROJECT_CONFIG.md'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {step === 'describe' && (
        <section>
          {folderBar}
          <h2>{kind === 'other' ? 'Describe your project' : 'Describe it and start'}</h2>
          <p className="hint">
            {kind === 'other'
              ? 'What is this project? A sentence or two — the agent picks up from here.'
              : 'Skip the setup questions — just say what you want to build and the agent starts.'}
          </p>
          <textarea
            className="describe-box"
            autoFocus
            rows={5}
            value={description}
            placeholder="e.g. A small tool that renames photos by the date they were taken."
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void createSimple();
            }}
          />
          {error && <p className="hint error-text">{error}</p>}
          <div className="modal-actions">
            <button
              className="ghost"
              onClick={() => setStep(kind === 'other' ? 'type' : 'coding')}
            >
              ← Back
            </button>
            <button
              className="send"
              disabled={busy || !description.trim()}
              onClick={() => void createSimple()}
            >
              {busy ? 'Creating…' : 'Create & start'}
            </button>
          </div>
        </section>
      )}

      {step === 'result' && result && (
        <section>
          <h2>Done</h2>
          {result.refused && <p className="hint error-text">{result.refused}</p>}
          {result.written.length > 0 && (
            <p className="hint">✓ Written: {result.written.join(', ')}</p>
          )}
          {result.skipped.length > 0 && (
            <p className="hint">Skipped (already present): {result.skipped.join(', ')}</p>
          )}
          {result.warnings.map((w, i) => (
            <p key={i} className="hint error-text">
              {w}
            </p>
          ))}
          <div className="modal-actions">
            <button className="ghost" onClick={backToOverview}>
              Back to projects
            </button>
            {createdProjectId && (
              <button
                className="send"
                onClick={() => {
                  const id = createdProjectId;
                  backToOverview();
                  void openProject(id);
                }}
              >
                Open project
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
