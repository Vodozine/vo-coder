import { useEffect, useState } from 'react';
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
import { useStore } from '../state/store';

const STATE_LABEL: Record<Detection['state'], string> = {
  new: 'New folder — full scaffold will be injected.',
  existing: 'Existing project — only missing files will be written, nothing overwritten.',
  managed: 'Already managed by Vo-Coder — regenerating needs Force.',
};

export function Scaffold() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const consumeScaffoldTarget = useStore((s) => s.consumeScaffoldTarget);

  const [dir, setDir] = useState<string | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [qState, setQState] = useState<QuestionnaireState>(start());
  const [seeded, setSeeded] = useState<string[]>([]);
  const [textValue, setTextValue] = useState('');
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<InjectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startQuestionnaire = (defaults: Record<string, string>) => {
    const state = seedAnswers(start(), defaults, ENV_QUESTION_IDS);
    setQState(state);
    setSeeded(ENV_QUESTION_IDS.filter((id) => id in state.answers));
  };

  const target = async (picked: string) => {
    setDir(picked);
    setDetection(await window.vo.scaffoldDetect(picked));
    startQuestionnaire(useStore.getState().config?.scaffoldDefaults ?? {});
    setResult(null);
    setError(null);
  };

  const pick = async () => {
    const picked = await window.vo.scaffoldPickDir();
    if (picked) await target(picked);
  };

  // A freshly created project hands its folder straight to the wizard.
  useEffect(() => {
    const handoff = consumeScaffoldTarget();
    if (handoff) void target(handoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const giveAnswer = (value: string) => {
    try {
      setQState(answer(qState, value));
      setTextValue('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const generate = async () => {
    if (!dir) return;
    const answers = toAnswers(qState);
    setResult(await window.vo.scaffoldGenerate(dir, answers, force));
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
  };

  const q = current(qState);
  const { done, total } = progress(qState);

  return (
    <div className="settings">
      <h1>Scaffold</h1>
      <p className="hint">
        Eight questions, one personalized PROJECT_CONFIG.md — the north star the harness and the
        infrastructure MCP build from.
      </p>

      <section>
        <h2>1 · Project folder</h2>
        <div className="field-row">
          <button onClick={() => void pick()}>Choose folder…</button>
          {dir && <span className="meta grow">{dir}</span>}
        </div>
        {detection && (
          <p className={`hint detect-${detection.state}`}>
            {STATE_LABEL[detection.state]}
            {detection.markers.length > 0 && ` Found: ${detection.markers.join(', ')}.`}
          </p>
        )}
        {detection?.state === 'managed' && (
          <label className="checkbox">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force regenerate PROJECT_CONFIG.md
          </label>
        )}
      </section>

      {dir && !result && (
        <section>
          <h2>
            2 · Questionnaire{' '}
            <span className="meta">
              {Math.min(done + 1, total)}/{total}
            </span>
          </h2>
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
                <button className="send" onClick={() => void generate()}>
                  Generate PROJECT_CONFIG.md
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {result && (
        <section>
          <h2>3 · Result</h2>
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
          <button
            onClick={() => {
              setResult(null);
              setQState(start());
              setDetection(null);
              setDir(null);
            }}
          >
            Scaffold another project
          </button>
        </section>
      )}
    </div>
  );
}
