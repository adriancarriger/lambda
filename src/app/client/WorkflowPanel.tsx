import { useState } from 'react';

import type {
  RenderMode,
  StepHistory,
  StepStatus,
  WorkflowStep,
} from '../../pod-store';
import type {
  AgentState,
  WorkflowStageView,
  WorkflowView,
} from '../shared/types';
import { Tip } from './Tip';

/**
 * The sidebar's workflow panel: every stage of the current pod's pipeline,
 * where it is, and — on hover — what each step does, who runs it, what it did
 * in this pod and what it does on average. For debugging the pipeline: which
 * steps are slow, which never find anything, where a pod is stuck.
 */

const duration = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '';
  }

  const minutes = Math.round(ms / 60_000);

  if (minutes < 1) {
    return `${Math.max(1, Math.round(ms / 1000))}s`;
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
};

const between = (from?: string, to?: string, now: number = Date.now()) =>
  from === undefined
    ? undefined
    : (to === undefined ? now : Date.parse(to)) - Date.parse(from);

const clock = (at: string): string =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const ICON = {
  done: '✓',
  skipped: '–',
  now: '▶',
  'waiting-you': '◆',
  todo: '○',
} as const;

const whoMark = (who: string): string => (who === 'you' ? 'you' : '⚙');

const historyLines = (
  history: StepHistory | undefined,
  repeated: boolean
): string[] => {
  if (history === undefined || history.runs === 0) {
    return ['Past planning Lambdas: no history yet.'];
  }

  const found =
    history.avgFound === undefined
      ? ''
      : ` · ${history.avgFound.toFixed(1)} found per ${
          repeated ? 'pass' : 'run'
        }`;
  const nothing =
    history.reportedFound === 0
      ? []
      : [
          `Found nothing in ${history.foundNothing} of ${
            history.reportedFound
          } ${repeated ? 'passes' : 'runs'}.`,
        ];

  return [
    `Past pods (${history.pods}): avg ${
      duration(history.avgMs) || '—'
    }${found}.`,
    ...nothing,
  ];
};

const thisPodLine = (status: StepStatus): string | undefined => {
  if (!status.tracked) {
    return status.state === 'done'
      ? 'This Lambda: done (not tracked — before step reporting).'
      : undefined;
  }

  const parts = [
    status.passes.length > 1 ? `${status.passes.length} passes` : undefined,
    status.progress,
    status.found === undefined ? undefined : `${status.found} found`,
    duration(between(status.startedAt, status.endedAt)),
  ].filter((part): part is string => part !== undefined && part !== '');

  return parts.length === 0 ? undefined : `This Lambda: ${parts.join(' · ')}.`;
};

const StepTip = ({
  step,
  status,
  history,
}: {
  step: WorkflowStep;
  status: StepStatus;
  history?: StepHistory;
}) => (
  <div className="workflow__tip">
    <strong>{step.label}</strong>
    <p>{step.tip}</p>
    <p>
      Who: {step.who === 'you' ? 'you' : `${step.who} (automated)`}
      {step.maxPasses === undefined ? '' : ` · up to ${step.maxPasses} passes`}
    </p>
    <p>Done when: {step.doneWhen}</p>
    {thisPodLine(status) !== undefined && <p>{thisPodLine(status)}</p>}
    {status.note !== undefined && <p>Note: {status.note}</p>}
    {historyLines(history, step.maxPasses !== undefined).map((line) => (
      <p key={line} className="workflow__tip-muted">
        {line}
      </p>
    ))}
  </div>
);

const StageTip = ({ view }: { view: WorkflowStageView }) => (
  <div className="workflow__tip">
    <strong>{view.stage.label}</strong>
    <p>{view.stage.tip}</p>
    {view.yourMs > 0 && <p>Your time here: {duration(view.yourMs)}.</p>}
    {view.avgYourMs !== undefined && (
      <p className="workflow__tip-muted">
        Your average across pods: {duration(view.avgYourMs)}.
      </p>
    )}
  </div>
);

const stepLabel = (step: WorkflowStep, status: StepStatus): string => {
  const pass = status.passes.at(-1);
  const passText =
    step.maxPasses === undefined || pass === undefined
      ? ''
      : ` · pass ${pass.pass}/${step.maxPasses}`;
  const progress =
    status.state === 'now' && status.progress !== undefined
      ? ` · ${status.progress}`
      : '';

  return `${step.label}${passText}${progress}`;
};

const agentLine = (name: string, agent: AgentState, now: number): string => {
  const since = duration(between(agent.since, undefined, now));

  return `${agent.working ? '●' : '○'} ${name} ${
    agent.working ? 'working' : 'idle'
  }${since === '' ? '' : ` · ${since}`}`;
};

const CELL = { done: '✓', now: '▶', todo: '·' } as const;

/** Batch pods: one row per ticket, one column per stage. */
const TicketGrid = ({ view }: { view: WorkflowView }) => {
  const columns = view.stages.filter(
    (stageView) => stageView.stage.steps.length > 0
  );

  return (
    <table className="workflow__grid">
      <thead>
        <tr>
          <th />
          {columns.map(({ stage }) => (
            <th key={stage.id} title={stage.label}>
              {stage.label.replace(/^\d+ /, '').slice(0, 3)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(view.tickets ?? []).map((row) => (
          <tr key={row.id}>
            <th>{row.id}</th>
            {columns.map(({ stage }) => {
              const cell = row.cells[stage.id] ?? 'todo';

              return (
                <td
                  key={stage.id}
                  className={`workflow__cell workflow__cell--${cell}`}
                  title={`${row.id} · ${stage.label}: ${cell}`}
                >
                  {CELL[cell]}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * Render Full | ASCII: whether the pod's UX review gets screenshots, designs
 * and prototypes, or ASCII only (faster). Takes effect at the next UX review.
 */
/** Shown under the switch when the pod's computer can't run Claude Design. */
export const FULL_UNAVAILABLE =
  "Full needs Claude Design, which isn't available with this Claude account.";

/**
 * `designAvailable` is what the pod's runner reports: `false` greys out
 * Full (absent: not checked yet, so Full stays on offer).
 */
export const RenderSwitch = ({
  mode,
  designAvailable,
  onChange,
}: {
  mode: RenderMode;
  designAvailable?: boolean;
  onChange: (mode: RenderMode) => void;
}) => {
  const fullOff = designAvailable === false;

  return (
    <>
      <p className="workflow__render">
        <Tip
          text={
            <div className="workflow__tip">
              <strong>Render</strong>
              <p>
                Full: the UX review shows screenshots, designs and prototypes.
                ASCII: no screenshots or Claude Design, ASCII only, so the pod
                plans faster. A change takes effect at the next UX review.
              </p>
            </div>
          }
        >
          Render
        </Tip>{' '}
        <span role="group" aria-label="Render the UX review as">
          {(['full', 'ascii'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`toggle${mode === option ? ' toggle--on' : ''}`}
              aria-pressed={mode === option}
              data-testid={`render-mode-${option}`}
              disabled={option === 'full' && fullOff}
              onClick={() => mode !== option && onChange(option)}
            >
              {option === 'full' ? 'Full' : 'ASCII'}
            </button>
          ))}
        </span>
      </p>
      {fullOff && (
        <p className="muted workflow__render-note">{FULL_UNAVAILABLE}</p>
      )}
    </>
  );
};

export const WorkflowPanel = ({
  podLabel,
  view,
  onSkip,
  onStructure,
  onRenderMode,
}: {
  podLabel: string | null;
  view: WorkflowView | null;
  /** Skip a stage that hasn't finished (the owner's call). */
  onSkip: (stageId: string, label: string, writesLinear: boolean) => void;
  /** Freeform → the structured flow, keeping the conversation. */
  onStructure: () => void;
  /** The Render Full | ASCII switch. */
  onRenderMode: (mode: RenderMode) => void;
}) => {
  // Stages opened by hand (the current one is always open).
  const [opened, setOpened] = useState<Set<string>>(new Set());

  if (view === null || podLabel === null) {
    return (
      <section className="workflow">
        <div className="sidebar__label">Workflow</div>
        <p className="muted workflow__empty">
          Open a pod or an item to see its workflow.
        </p>
      </section>
    );
  }

  const now = Date.now();
  const lastWatchdog = view.watchdog.at(-1);
  const recentWatchdog =
    lastWatchdog !== undefined &&
    now - Date.parse(lastWatchdog.at) < 60 * 60_000
      ? lastWatchdog
      : undefined;
  const toggle = (id: string): void =>
    setOpened((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });

  if (view.freeform) {
    return (
      <section className="workflow">
        <div className="sidebar__label">Workflow · {podLabel}</div>
        <RenderSwitch
          mode={view.renderMode}
          designAvailable={view.designAvailable}
          onChange={onRenderMode}
        />
        <p className="workflow__agents">
          <span>{agentLine('dev', view.agents.dev, now)}</span>
        </p>
        <p className="muted workflow__empty">
          Freeform: a conversation with the dev — no stages or checkpoints.
          Switch when you want the planning pipeline; it starts from what you
          have said so far.
        </p>
        <button type="button" className="ghost" onClick={onStructure}>
          Switch to structured
        </button>
      </section>
    );
  }

  return (
    <section className="workflow">
      <div className="sidebar__label">Workflow · {podLabel}</div>
      <RenderSwitch
        mode={view.renderMode}
        designAvailable={view.designAvailable}
        onChange={onRenderMode}
      />
      {view.tickets !== undefined && <TicketGrid view={view} />}
      <p className="workflow__agents">
        <span>{agentLine('dev', view.agents.dev, now)}</span>
        <span>{agentLine('manager', view.agents.manager, now)}</span>
      </p>
      {view.requests
        .filter((request) => request.status !== 'done')
        .map((request) => (
          <p key={request.id} className="workflow__request">
            <Tip
              text={
                <div className="workflow__tip">
                  <strong>Work request {request.id}</strong>
                  <p>“{request.quote}”</p>
                  <p>
                    {request.status === 'queued'
                      ? 'Queued — the manager starts it right away, interrupting the dev.'
                      : 'The dev is on it.'}{' '}
                    Meanwhile this Lambda's items are out of your inbox; they
                    come back re-checked, and anything it made stale is redone.
                  </p>
                </div>
              }
            >
              ⏸ Request · {request.summary}
              {' · '}
              {request.status === 'queued'
                ? 'queued'
                : `working ${duration(
                    between(request.startedAt, undefined, now)
                  )}`}
            </Tip>
          </p>
        ))}
      {view.requests.some((request) => request.status === 'done') && (
        <p className="workflow__requests-done muted">
          <Tip
            text={
              <div className="workflow__tip">
                <strong>Work requests done</strong>
                {view.requests
                  .filter((request) => request.status === 'done')
                  .map((request) => (
                    <p key={request.id}>
                      {request.id} · {request.summary} — {request.result ?? ''}{' '}
                      ({duration(between(request.startedAt, request.doneAt))})
                    </p>
                  ))}
              </div>
            }
          >
            ✓{' '}
            {
              view.requests.filter((request) => request.status === 'done')
                .length
            }{' '}
            work request(s) done
          </Tip>
        </p>
      )}
      {recentWatchdog !== undefined && (
        <p className="workflow__watchdog">
          <Tip
            text={
              <div className="workflow__tip">
                <strong>Watchdog</strong>
                <p>
                  When nothing is running and nothing waits on you for 90s, the
                  app nudges the manager (twice at most, 2 minutes apart). If
                  that doesn't get it moving — or an agent is on a permission
                  prompt or hung — it goes to your inbox as Stalled.
                </p>
                {view.watchdog.map((entry) => (
                  <p key={entry.at} className="workflow__tip-muted">
                    {clock(entry.at)} · {entry.note}
                  </p>
                ))}
              </div>
            }
          >
            ⚙ {clock(recentWatchdog.at)} · {recentWatchdog.note}
          </Tip>
        </p>
      )}
      <ol className="workflow__stages">
        {view.stages.map((stageView) => {
          const { stage, status } = stageView;
          const isCurrent =
            status.state === 'now' || status.state === 'waiting-you';
          const open = isCurrent || opened.has(stage.id);
          const time =
            stage.kind === 'checkpoint'
              ? duration(stageView.yourMs || undefined)
              : duration(
                  between(
                    status.startedAt,
                    status.state === 'done' ? status.endedAt : undefined,
                    now
                  )
                );

          return (
            <li
              key={stage.id}
              className={`workflow__stage workflow__stage--${status.state}`}
            >
              <button
                type="button"
                className="workflow__row"
                onClick={() => toggle(stage.id)}
                disabled={stage.steps.length === 0}
              >
                <span className="workflow__icon">{ICON[status.state]}</span>
                <Tip
                  className="workflow__label"
                  text={<StageTip view={stageView} />}
                >
                  {stage.label}
                </Tip>
                <span className="workflow__who">{whoMark(stage.who)}</span>
                <span className="workflow__time">{time}</span>
              </button>
              {(status.state === 'todo' ||
                status.state === 'now' ||
                status.state === 'waiting-you') && (
                <button
                  type="button"
                  className="workflow__skip link-button"
                  title={`Skip ${stage.label} — this Lambda passes it by`}
                  onClick={() =>
                    onSkip(
                      stage.id,
                      stage.label,
                      view.confirmSkip.includes(stage.id)
                    )
                  }
                >
                  Skip
                </button>
              )}
              {open && stage.steps.length > 0 && (
                <ul className="workflow__steps">
                  {stage.steps.map((step) => {
                    const stepStatus = status.steps.find(
                      (candidate) => candidate.id === step.id
                    );

                    if (stepStatus === undefined) {
                      return null;
                    }

                    return (
                      <li
                        key={step.id}
                        className={`workflow__step workflow__step--${
                          stepStatus.state
                        }${
                          stepStatus.tracked ? '' : ' workflow__step--untracked'
                        }`}
                      >
                        <span className="workflow__icon">
                          {ICON[stepStatus.state]}
                        </span>
                        <Tip
                          className="workflow__label"
                          text={
                            <StepTip
                              step={step}
                              status={stepStatus}
                              history={view.history[step.id]}
                            />
                          }
                        >
                          {stepLabel(step, stepStatus)}
                        </Tip>
                        <span className="workflow__who">
                          {whoMark(step.who)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <p className="workflow__legend muted">
        ⚙ automated · you · ▶ now · ◆ waiting on you · ✓ done
      </p>
    </section>
  );
};
