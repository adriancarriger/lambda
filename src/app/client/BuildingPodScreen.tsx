import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  BuildTicketRun,
  Screenshot,
  ThreadMessage,
} from '../../pod-store';
import {
  type StepStatus,
  formatMinutes,
  thisTicketMs,
  ticketTimeline,
  wholeRun,
} from '../shared/buildTimeline';
import {
  type BuildingPodDetail,
  NOTHING_READY_TO_BUILD,
  type VisualIssueView,
  type VisualPictureView,
  type VisualRoundView,
  buildingLine,
  buildingRefreshIn,
  buildingReplyItems,
  buildingScreenMode,
  currentRun,
  headerBuilding,
  pauseHeld,
  railPlaceholder,
  runShots,
  takenTickets,
  ticketsRail,
  visualPictureUrl,
  visualRail,
} from '../shared/building';
import { buildingChat } from '../shared/conversation';
import { podName } from '../shared/podName';
import type { LambdaInfo, PodSummary } from '../shared/types';
import { Markdown } from './Message';
import {
  BUILDING_RAILS,
  MIN_CHAT,
  RailHost,
  RailSwitcher,
  type Rails,
} from './Rails';
import { WindowPicker } from './WindowPicker';
import { api } from './api';
import { errorText, latestLoader } from './loading';

/**
 * A building pod's page: the planning shell, but the chat is with the
 * read-only Product manager (the Engineering manager's progress lines show
 * as small bubbles in it), and the rails are Workflow, Tickets and Agents.
 * Nothing here is scraped from a terminal: it's all stored messages and
 * events.
 */

const ROLE_NAMES: Record<string, string> = {
  'engineering-manager': 'Engineering manager',
  'product-manager': 'Product manager',
  dev: 'Dev',
  qa: 'QA',
  manager: 'Manager',
  system: 'Lambda',
};

/** "Engineering manager", "Ask a1b2" for an ask fork's window. */
export const roleName = (window: string): string =>
  ROLE_NAMES[window] ??
  (window.startsWith('ask-') ? `Ask ${window.slice(4)}` : window);

/** A building pod's window: its Engineering manager runs in `manager`. */
export const buildingWindowName = (window: string): string =>
  window === 'manager'
    ? ROLE_NAMES['engineering-manager'] ?? window
    : roleName(window);

const elapsed = (from: string, now: number): number =>
  Math.max(0, now - Date.parse(from));

/**
 * The answer box under an item waiting on the owner (a Blocked item): sent to
 * the pod on that item, so it settles it, never to the Product manager.
 */
const ItemAnswer = ({
  onAnswer,
}: {
  onAnswer: (text: string) => Promise<unknown>;
}) => {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const send = (): void => {
    const text = draft.trim();

    if (text === '' || sending) {
      return;
    }

    setSending(true);
    onAnswer(text)
      .then(() => setDraft(''))
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  return (
    <div className="build-answer">
      <textarea
        rows={2}
        value={draft}
        placeholder="Answer this item…"
        aria-label="Answer this item"
        readOnly={sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <button
        type="button"
        onClick={send}
        disabled={sending || draft.trim() === ''}
      >
        Send
      </button>
    </div>
  );
};

/**
 * One chat line: the owner's, the Product manager's, or a role's bubble. A
 * bubble the owner owes an answer (`onAnswer`) carries its answer box.
 */
export const ChatLine = ({
  message,
  onAnswer,
}: {
  message: ThreadMessage;
  onAnswer?: (text: string) => Promise<unknown>;
}) => {
  if (message.from === 'human') {
    return (
      <div className="msg msg--you">
        <Markdown text={message.text} />
      </div>
    );
  }

  if (message.from === 'product-manager') {
    return (
      <div className="msg msg--claude">
        <span className="msg__label">Lambda</span>
        <Markdown text={message.text} />
      </div>
    );
  }

  // Markdown, like the Product manager's: a Blocked item's four bold parts,
  // and the visual check's expected | actual pictures when it blocked it.
  const at = message.picturesAt;

  return (
    <div className="build-bubble">
      <span className="build-bubble__dot" aria-hidden="true">
        ◦
      </span>
      <strong>Lambda:</strong>
      <Markdown text={message.text} />
      {at !== undefined && (message.pictures ?? []).length > 0 && (
        <span className="build-bubble__pictures">
          {(message.pictures ?? []).map((file) => {
            const url = visualPictureUrl(
              message.podId,
              at.ticketId,
              at.round,
              file
            );

            return (
              <a key={file} href={url} target="_blank" rel="noreferrer">
                <img
                  src={url}
                  alt={`Expected and actual: ${file
                    .replace(/^composite-/, '')
                    .replace(/\.png$/, '')}`}
                />
              </a>
            );
          })}
        </span>
      )}
      {onAnswer !== undefined && <ItemAnswer onAnswer={onAnswer} />}
    </div>
  );
};

/** One picture of a visual check round, opened from the Workflow rail. */
export interface OpenPair {
  ticketId: string;
  round: VisualRoundView;
  picture: VisualPictureView;
}

const SEVERITY_NAMES: Record<VisualIssueView['severity'], string> = {
  high: 'High',
  medium: 'Medium',
  'medium-low': 'Medium-low',
  low: 'Low',
};

/** "Medium · Legend: below the map, should be beside it". */
export const visualIssueLine = (issue: VisualIssueView): string =>
  `${SEVERITY_NAMES[issue.severity]} · ${issue.where}: ${issue.what}`;

/** A visual check pair, full size, with that round's issues for it. */
export const VisualPairViewer = ({
  podId,
  open,
  onClose,
}: {
  podId: string;
  open: OpenPair;
  onClose: () => void;
}) => {
  const close = useRef<HTMLButtonElement | null>(null);
  const closing = useRef(onClose);
  closing.current = onClose;

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closing.current();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { ticketId, round, picture } = open;
  const url = (file: string): string =>
    visualPictureUrl(podId, ticketId, round.round, file);

  return (
    <div
      className="dialog dialog--screenshot"
      role="dialog"
      aria-modal="true"
      aria-label={`Visual check · round ${round.round}`}
    >
      <div className="dialog__head">
        <h2>
          Visual check · round {round.round} · {picture.situation}
        </h2>
        <button type="button" className="ghost" onClick={onClose} ref={close}>
          Close
        </button>
      </div>
      <div className="visual-pair">
        <figure>
          <figcaption>Expected</figcaption>
          <img
            className="screenshot__full"
            src={url(picture.expected)}
            alt=""
          />
        </figure>
        <figure>
          <figcaption>Actual</figcaption>
          <img className="screenshot__full" src={url(picture.actual)} alt="" />
        </figure>
      </div>
      {picture.issues.length === 0 ? (
        <p>No issues this round.</p>
      ) : (
        <ul className="visual-pair__issues">
          {picture.issues.map((issue, index) => (
            // Two issues can read the same: keyed by place too.
            <li key={`${index}:${issue.where}`}>{visualIssueLine(issue)}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** A test screenshot, full size, with what the tester saw. */
export const ScreenshotViewer = ({
  podId,
  shot,
  onClose,
}: {
  podId: string;
  shot: Screenshot;
  onClose: () => void;
}) => {
  const close = useRef<HTMLButtonElement | null>(null);
  // The latest onClose, so a re-render doesn't move focus back to Close.
  const closing = useRef(onClose);
  closing.current = onClose;

  // Keyboard users land in it and can leave it: focus on Close, Escape closes.
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closing.current();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="dialog dialog--screenshot"
      role="dialog"
      aria-modal="true"
      aria-label={`Test · attempt ${shot.attempt}`}
    >
      <div className="dialog__head">
        <h2>
          Test · attempt {shot.attempt} · {shot.passed ? '✓' : '✗'}
        </h2>
        <button type="button" className="ghost" onClick={onClose} ref={close}>
          Close
        </button>
      </div>
      <img
        className="screenshot__full"
        src={screenshotUrl(podId, shot)}
        alt={shot.conclusion}
      />
      <p className="screenshot__url">{shot.url}</p>
      {shot.consoleErrors.map((line, index) => (
        // Two console lines can read the same: keyed by place too.
        <p key={`${index}:${line}`} className="screenshot__console">
          Console: {line}
        </p>
      ))}
      <p>Tester: {shot.conclusion}</p>
    </div>
  );
};

export const screenshotUrl = (podId: string, shot: Screenshot): string =>
  `/api/pod-file/${encodeURIComponent(podId)}/screenshots/${encodeURIComponent(
    shot.ticketId
  )}/${shot.attempt}/${encodeURIComponent(shot.file)}`;

const Bar = ({ ms, max }: { ms: number; max: number }) => (
  <span className="build-bar" aria-hidden="true">
    <span
      className="build-bar__fill"
      style={{ width: `${max === 0 ? 0 : Math.round((ms / max) * 100)}%` }}
    />
  </span>
);

const STEP_MARKS: Record<StepStatus, string> = {
  done: '✓',
  active: '●',
  todo: '○',
  skipped: '–',
};

/** The Visual check row's pictures: one expected | actual pair per picture per round. */
export const VisualPairs = ({
  podId,
  ticketId,
  rounds,
  onPair,
}: {
  podId: string;
  ticketId: string;
  rounds: VisualRoundView[];
  onPair: (open: OpenPair) => void;
}) => (
  <span className="build-step__pairs">
    {rounds.map((round) => (
      <span
        key={round.round}
        className="build-pairs"
        title={`Round ${round.round}`}
      >
        {round.pictures.map((picture) => {
          const missed = picture.issues.length > 0;

          return (
            <button
              key={picture.scenarioId}
              type="button"
              className={`build-pair${missed ? ' build-pair--missed' : ''}`}
              title={`Round ${round.round} · ${picture.situation}`}
              // Its images are unlabelled, so without this the ✗ would be its name.
              aria-label={`Round ${round.round} · ${picture.situation}${
                missed ? ' · has issues' : ''
              }`}
              onClick={() => onPair({ ticketId, round, picture })}
            >
              <img
                src={visualPictureUrl(
                  podId,
                  ticketId,
                  round.round,
                  picture.expected
                )}
                alt=""
              />
              <img
                src={visualPictureUrl(
                  podId,
                  ticketId,
                  round.round,
                  picture.actual
                )}
                alt=""
              />
              {missed && (
                <span className="build-shot__fail" aria-hidden="true">
                  ✗
                </span>
              )}
            </button>
          );
        })}
      </span>
    ))}
  </span>
);

export const WorkflowRail = ({
  detail,
  now,
  onShot,
  onPair,
  ticketId,
}: {
  detail: BuildingPodDetail;
  now: number;
  onShot: (shot: Screenshot) => void;
  onPair: (open: OpenPair) => void;
  /** One ticket's newest run (a Lambda's page), not the pod's current one. */
  ticketId?: string;
}) => {
  const [whole, setWhole] = useState(false);
  const run =
    ticketId === undefined
      ? currentRun(detail.building) ?? detail.building.runs.at(-1)
      : detail.building.runs.filter((one) => one.id === ticketId).at(-1);
  const taken = useMemo(() => takenTickets(detail.building), [detail]);
  // Worked out once per read or clock tick, not on every render.
  const timeline = useMemo(
    () =>
      run === undefined
        ? null
        : // Only this run of it, on this pod: a ticket blocked and taken
          // again starts over, and a blocked run's time stops at its block.
          ticketTimeline(detail.events, run.id, detail.steps, now, {
            pod: detail.pod.id,
            run,
          }),
    [detail, run, now]
  );
  const total = useMemo(
    () =>
      wholeRun(detail.events, taken, detail.steps, now, {
        pod: detail.pod.id,
        runs: detail.building.runs,
      }),
    [detail, taken, now]
  );

  if (run === undefined || timeline === null) {
    return <p className="rail__empty">{NOTHING_READY_TO_BUILD}.</p>;
  }

  const max = Math.max(0, ...timeline.steps.map((step) => step.ms));
  const thisMs = thisTicketMs(run, timeline.totalMs, now);
  const typical = detail.typicalMs;
  const scale = Math.max(thisMs, typical ?? 0);
  const shotsOf = (attempt: number): Screenshot[] =>
    runShots(detail.screenshots, run, attempt);
  // A page from a runner older than the visual check has no `visual`.
  const visual = visualRail(detail.visual ?? {}, run);

  return (
    <div className="build-workflow">
      <h3 className="build-workflow__title">
        Workflow · {run.id} {run.title}
      </h3>
      {!whole && (
        <ol className="build-steps">
          {timeline.steps.map((step) => (
            <li
              key={step.id}
              className={`build-step build-step--${step.status}`}
            >
              <span className="build-step__mark" aria-hidden="true">
                {STEP_MARKS[step.status]}
              </span>
              <span className="build-step__label">
                {step.id === 'visual-check' &&
                step.status !== 'skipped' &&
                visual.label !== null
                  ? visual.label
                  : step.label}
              </span>
              <Bar ms={step.ms} max={max} />
              <span className="build-step__time">
                {step.ms > 0 ? formatMinutes(step.ms) : ''}
              </span>
              {step.id === 'test' && step.attempt > 0 && (
                <span className="build-step__shots">
                  {Array.from({ length: step.attempt }, (_, index) =>
                    shotsOf(index + 1)
                  )
                    .flat()
                    .map((shot) => (
                      <button
                        key={`${shot.attempt}/${shot.file}`}
                        type="button"
                        className={`build-shot${
                          shot.passed ? '' : ' build-shot--failed'
                        }`}
                        title={shot.conclusion}
                        onClick={() => onShot(shot)}
                      >
                        <img src={screenshotUrl(detail.pod.id, shot)} alt="" />
                        {!shot.passed && (
                          <span className="build-shot__fail">✗</span>
                        )}
                      </button>
                    ))}
                </span>
              )}
              {step.id === 'visual-check' &&
                step.status !== 'skipped' &&
                visual.rounds.length > 0 && (
                  <VisualPairs
                    podId={detail.pod.id}
                    ticketId={run.id}
                    rounds={visual.rounds}
                    onPair={onPair}
                  />
                )}
              {step.id === 'ship' && timeline.shipStages.length > 0 && (
                <span className="build-step__stages">
                  {timeline.shipStages.join(' · ')}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {whole && (
        <ol className="build-steps">
          {total.steps
            .filter((step) => step.ms > 0)
            .map((step) => (
              <li
                key={step.id}
                className="build-step build-step--done build-step--whole"
              >
                <span className="build-step__label">{step.label}</span>
                <span className="build-step__time">{step.percent}%</span>
                <Bar ms={step.ms} max={total.totalMs} />
                <span className="build-step__time">
                  {formatMinutes(step.ms)}
                </span>
              </li>
            ))}
          <li className="build-step build-step--total">
            Total {formatMinutes(total.totalMs)} across {taken.length}{' '}
            {taken.length === 1 ? 'ticket' : 'tickets'}
          </li>
        </ol>
      )}
      {!whole && (
        <dl className="build-compare">
          <dt>This ticket</dt>
          <dd>
            {formatMinutes(thisMs)} <Bar ms={thisMs} max={scale} />
          </dd>
          {typical !== null && (
            <>
              <dt>Typical ticket</dt>
              <dd>
                {formatMinutes(typical)} <Bar ms={typical} max={scale} />
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="segmented" role="group" aria-label="Timeline">
        <button
          type="button"
          aria-pressed={!whole}
          className={whole ? '' : 'segmented--on'}
          onClick={() => setWhole(false)}
        >
          This ticket
        </button>
        <button
          type="button"
          aria-pressed={whole}
          className={whole ? 'segmented--on' : ''}
          onClick={() => setWhole(true)}
        >
          Whole run
        </button>
      </div>
    </div>
  );
};

const TicketsRail = ({
  detail,
  now,
  onOpenTicket,
}: {
  detail: BuildingPodDetail;
  now: number;
  onOpenTicket: (ticketId: string) => void;
}) => {
  const { done, current, upNext } = ticketsRail(detail.building);
  // A Done ticket's time only changes with a new read.
  const doneTimes = useMemo(
    () =>
      new Map(
        ticketsRail(detail.building).done.map((run) => {
          const total = ticketTimeline(
            detail.events,
            run.id,
            detail.steps,
            now,
            { pod: detail.pod.id, run }
          ).totalMs;

          return [run.id, total === null ? '' : formatMinutes(total)];
        })
      ),
    [detail, now]
  );
  const timeOf = (run: BuildTicketRun): string => doneTimes.get(run.id) ?? '';
  const row = (id: string, title: string, mark: string, time: string) => (
    <li key={id}>
      <button
        type="button"
        className="build-ticket"
        onClick={() => onOpenTicket(id)}
      >
        <span className="build-ticket__mark" aria-hidden="true">
          {mark}
        </span>
        <span className="build-ticket__title">
          {id} {title}
        </span>
        <span className="build-ticket__time">{time}</span>
      </button>
    </li>
  );

  return (
    <div className="build-tickets">
      {done.length > 0 && (
        <>
          <h3 className="build-tickets__head">Done</h3>
          <ul>{done.map((run) => row(run.id, run.title, '✓', timeOf(run)))}</ul>
        </>
      )}
      {current !== null && (
        <>
          <h3 className="build-tickets__head">Current</h3>
          <ul>
            {row(
              current.id,
              current.title,
              '●',
              `${formatMinutes(elapsed(current.startedAt, now))}…`
            )}
          </ul>
        </>
      )}
      <h3 className="build-tickets__head">Up next</h3>
      {upNext.length === 0 ? (
        <p className="muted">Nothing else is ready.</p>
      ) : (
        <ul>{upNext.map((next) => row(next.id, next.title, '', ''))}</ul>
      )}
    </div>
  );
};

const AgentsRail = ({
  detail,
  project,
  onError,
}: {
  detail: BuildingPodDetail;
  project: string;
  onError: (caught: unknown) => void;
}) => (
  <WindowPicker
    podId={detail.pod.id}
    project={detail.pod.projectId ?? project}
    agents={detail.windows}
    labelOf={buildingWindowName}
    fallback="manager"
    onError={onError}
  />
);

export const BuildingPodScreen = ({
  summary,
  lambda,
  rails,
  tick,
  onOpenTicket,
}: {
  summary: PodSummary;
  lambda: LambdaInfo | undefined;
  rails: Rails;
  tick: number;
  /** The ticket page, on the Tickets screen. */
  onOpenTicket: (projectId: string, ticketId: string) => void;
}) => {
  const podId = summary.pod.id;
  const [detail, setDetail] = useState<BuildingPodDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the person did that failed (a send, Pause, a terminal): kept until
  // dismissed, where a load's error clears on the next good read.
  const [actionError, setActionError] = useState<string | null>(null);
  const failed = (caught: unknown): void => setActionError(errorText(caught));
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** The pod's status when Pause/Resume was clicked, while it's held. */
  const [pausingFrom, setPausingFrom] = useState<
    PodSummary['pod']['status'] | null
  >(null);
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [pair, setPair] = useState<OpenPair | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = useMemo(
    () =>
      latestLoader<BuildingPodDetail>({ value: setDetail, error: setError }),
    []
  );

  // Each app event ticks, and a busy project sends many: read at most every
  // BUILDING_REFRESH_MS, a tick inside the wait read once it is up.
  const loadedAt = useRef<number | null>(null);

  useEffect(() => {
    const read = (): void => {
      loadedAt.current = Date.now();
      void load(api.building(podId));
    };
    const wait = buildingRefreshIn(loadedAt.current, Date.now());

    if (wait === 0) {
      read();

      return undefined;
    }

    const timer = window.setTimeout(read, wait);

    return () => window.clearTimeout(timer);
  }, [load, podId, tick]);

  // Released once the pod's status moves on, so a later toggle elsewhere
  // (back to the clicked-from status) doesn't hold it again.
  useEffect(() => setPausingFrom(null), [summary.pod.status]);

  // The current ticket's time counts up while it's on screen.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);

    return () => window.clearInterval(id);
  }, []);

  const projectId = lambda?.podProjects[podId] ?? summary.pod.projectId;
  const project =
    lambda?.projects.find((one) => one.id === projectId)?.name ??
    podName(summary.pod);
  // "Talk about this ticket": a chat with the Product manager about one
  // ticket. It builds nothing, so it has no Pause and no building rails.
  const talk = buildingScreenMode(summary.pod) === 'talk';
  const building = talk
    ? undefined
    : headerBuilding(summary.building, detail?.summary);
  const paused = summary.pod.status === 'paused';
  const pausing = pauseHeld(pausingFrom, summary.pod.status);
  const rail =
    !talk && rails.rail !== null && BUILDING_RAILS.includes(rails.rail)
      ? rails.rail
      : null;
  const expanded = rails.expanded && rail !== null;
  const thread = buildingChat(detail?.thread ?? []);
  // The items the sidebar says wait on the owner, answerable here too.
  const waiting = new Set(
    detail === null
      ? []
      : buildingReplyItems(detail.thread, talk ? null : detail.building).map(
          (message) => message.id
        )
  );

  /** An answer on one item: to the pod, about that item (it settles it). */
  const answer = (messageId: string, text: string): Promise<unknown> => {
    setActionError(null);

    return api
      .chat(podId, text, messageId)
      .then(() => load(api.building(podId)))
      .catch((caught: unknown) => {
        failed(caught);

        throw caught;
      });
  };

  const send = (): void => {
    const text = draft.trim();

    if (text === '' || sending) {
      return;
    }

    setSending(true);
    setActionError(null);
    api
      .pmChat(podId, text)
      .then(() => {
        setDraft('');
        void load(api.building(podId));
      })
      .catch(failed)
      .finally(() => setSending(false));
  };

  const togglePause = (): void => {
    if (pausing) {
      return;
    }

    setPausingFrom(summary.pod.status);
    (paused ? api.resume(podId) : api.pause(podId)).catch((caught: unknown) => {
      setPausingFrom(null);
      failed(caught);
    });
  };

  return (
    <div
      className="workspace"
      style={{
        gridTemplateColumns:
          rail === null || expanded
            ? 'minmax(0, 1fr)'
            : `minmax(${MIN_CHAT}px, 1fr) ${rails.width}px`,
      }}
    >
      <main className="main" hidden={expanded}>
        <div className="toolbar">
          <h1 className="toolbar__title">
            {project}
            {building !== undefined && (
              <span className="muted"> · {buildingLine(building)}</span>
            )}
            {talk && summary.pod.talk !== undefined && (
              <span className="muted">
                {' '}
                · ticket {summary.pod.talk.ticketId}
              </span>
            )}
          </h1>
          {!talk && (
            <div className="toolbar__right">
              <button
                type="button"
                className="ghost"
                onClick={togglePause}
                disabled={pausing}
              >
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <RailSwitcher
                rails={rails}
                shown={rail}
                badges={{}}
                ids={BUILDING_RAILS}
              />
            </div>
          )}
        </div>
        {error !== null && (
          <button
            type="button"
            className="error"
            onClick={() => setError(null)}
          >
            {error} (dismiss)
          </button>
        )}
        {actionError !== null && (
          <button
            type="button"
            className="error"
            onClick={() => setActionError(null)}
          >
            {actionError} (dismiss)
          </button>
        )}
        <section className="center-chat">
          <div className="chat-panel__log">
            {thread.map((message) => (
              <ChatLine
                key={message.id}
                message={message}
                onAnswer={
                  waiting.has(message.id)
                    ? (text) => answer(message.id, text)
                    : undefined
                }
              />
            ))}
            {building?.current === null && (
              <p className="chat__empty muted">
                {building.idleReason ?? NOTHING_READY_TO_BUILD}
              </p>
            )}
          </div>
          <footer className="chat-panel__compose">
            <div className="image-drop">
              <textarea
                rows={1}
                value={draft}
                placeholder="Ask Lambda…"
                // Not disabled: that drops focus after every send.
                readOnly={sending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            </div>
          </footer>
        </section>
      </main>

      {rail === 'workflow' && (
        <RailHost rails={rails} title="Workflow">
          <div className="rail__scroll">
            {detail === null ? (
              <p className="rail__empty">{railPlaceholder(error)}</p>
            ) : (
              <WorkflowRail
                detail={detail}
                now={now}
                onShot={setShot}
                onPair={setPair}
              />
            )}
          </div>
        </RailHost>
      )}
      {rail === 'tickets' && (
        <RailHost rails={rails} title="Tickets">
          <div className="rail__scroll">
            {detail === null ? (
              <p className="rail__empty">{railPlaceholder(error)}</p>
            ) : (
              <TicketsRail
                detail={detail}
                now={now}
                onOpenTicket={(ticketId) =>
                  projectId === undefined
                    ? undefined
                    : onOpenTicket(projectId, ticketId)
                }
              />
            )}
          </div>
        </RailHost>
      )}
      {rail === 'agents' && (
        <RailHost rails={rails} title={`Agents · ${project}`} dark>
          {detail === null ? (
            <p className="rail__empty">{railPlaceholder(error)}</p>
          ) : (
            <AgentsRail detail={detail} project={project} onError={failed} />
          )}
        </RailHost>
      )}
      {shot !== null && (
        <ScreenshotViewer
          podId={podId}
          shot={shot}
          onClose={() => setShot(null)}
        />
      )}
      {pair !== null && (
        <VisualPairViewer
          podId={podId}
          open={pair}
          onClose={() => setPair(null)}
        />
      )}
    </div>
  );
};
