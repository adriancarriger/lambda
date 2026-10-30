import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type { Screenshot } from '../../pod-store';
import { formatMinutes, stepDisplayName } from '../shared/buildTimeline';
import {
  type BuildingPodDetail,
  type TicketPage,
  buildingRefreshIn,
  currentRun,
} from '../shared/building';
import {
  ago,
  epicProgress,
  filesLine,
  focusTicket,
  foldedLine,
  mainAction,
  phaseDivider,
  queuePlace,
  stripStepOf,
} from '../shared/lambdaPage';
import type { Lambda, LambdaPhase, LambdaTicket } from '../shared/lambdas';
import { lambdaDefaultRail, lambdaRailsOf } from '../shared/screenChoice';
import { ticketActivity } from '../shared/ticketBoard';
import type { AppState, PodDetail } from '../shared/types';
import { BlockerCard, blockerAnswer } from './BlockerCard';
import {
  ChatLine,
  type OpenPair,
  ScreenshotViewer,
  VisualPairViewer,
  VisualPairs,
  WorkflowRail,
  buildingWindowName,
  roleName,
  screenshotUrl,
} from './BuildingPodScreen';
import { TicketMark } from './LambdaTickets';
import { Markdown } from './Message';
import { PhaseStrip } from './PhaseStrip';
import { StarButton } from './ProjectIcon';
import { MadeRail } from './Prototypes';
import {
  MIN_CHAT,
  RailHost,
  type RailId,
  RailSwitcher,
  type Rails,
} from './Rails';
import { ViewerProvider } from './Viewer';
import { WindowPicker } from './WindowPicker';
import { api } from './api';
import { errorText, latestLoader } from './loading';
import { type ReadAloudSection, useReadAloud } from './useReadAloud';

/**
 * A Lambda's page past planning: one page for its whole life. The header
 * (title, project and ticket, ⋯), the phase strip, one conversation (the
 * planning before it folded to a line, a divider where each phase starts,
 * the build's progress and anything waiting on the owner answered in
 * place), and the phase's rail with read aloud and its main action.
 */

const PLANNING_WINDOWS = (window: string): string =>
  window === 'dev'
    ? 'Dev'
    : window === 'manager'
    ? 'Manager'
    : `Fork ${window.slice(5)}`;

/** Whoever answers, it's Lambda: the agent behind it never shows. */
const TALKERS: Record<'you' | 'product-manager' | 'dev', string> = {
  you: 'You',
  'product-manager': 'Lambda',
  dev: 'Lambda',
};

type PagePhase = Exclude<LambdaPhase, 'planning'>;

type MadeFilter = 'all' | 'planning' | 'building';

const MADE_FILTERS: MadeFilter[] = ['all', 'planning', 'building'];

const pagePhase = (phase: LambdaPhase): PagePhase =>
  phase === 'planning' ? 'done' : phase;

const COMPOSE: Record<PagePhase, { label: string; placeholder: string }> = {
  queued: {
    label: 'To Lambda · it knows the plan and the code',
    placeholder: 'Ask about it, or change it…',
  },
  building: {
    label: 'To Lambda',
    placeholder: 'Answer in your own words, or ask something…',
  },
  qa: {
    label: 'To Lambda',
    placeholder: 'What should change? (sent with Send back)',
  },
  shipped: {
    label: 'To Lambda · it has the diff',
    placeholder: 'Ask about what shipped…',
  },
  done: {
    label: 'To Lambda',
    placeholder: 'Ask about it…',
  },
};

const SpeakerIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6" />
  </svg>
);

/** A rail section's heading, with its read-aloud button. */
const Heading = ({
  children,
  onRead,
}: {
  children: ReactNode;
  onRead?: () => void;
}) => (
  <h3 className="lambda-rail__head">
    {children}
    {onRead !== undefined && (
      <button
        type="button"
        className="lambda-rail__read"
        aria-label="Read aloud"
        title="Read aloud"
        onClick={onRead}
      >
        <SpeakerIcon />
      </button>
    )}
  </h3>
);

/** The player bar: read aloud, and the phase's main action (⌘⏎). */
const PlayerBar = ({
  read,
  action,
  busy,
  onAction,
}: {
  read: ReturnType<typeof useReadAloud>;
  action: string | null;
  busy: boolean;
  onAction: () => void;
}) => (
  <footer className="rail__actions lambda-player">
    <button
      type="button"
      className="lambda-player__skip"
      aria-label="Previous section"
      onClick={() => read.step(-1)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 5h2v14H6zM20 5v14L9 12z" />
      </svg>
    </button>
    <button
      type="button"
      className="lambda-player__play"
      aria-label={read.playing ? 'Pause' : 'Play'}
      onClick={read.toggle}
    >
      {read.playing ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 4v16l13-8z" />
        </svg>
      )}
    </button>
    <button
      type="button"
      className="lambda-player__skip"
      aria-label="Next section"
      onClick={() => read.step(1)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
      </svg>
    </button>
    <button
      type="button"
      className="lambda-player__speed"
      onClick={() => read.setSpeed(read.speed === 1 ? 2 : 1)}
    >
      {read.speed}×
    </button>
    <span className="lambda-player__spacer" />
    {action !== null && (
      <button
        type="button"
        className="primary done"
        disabled={busy}
        onClick={onAction}
      >
        <span className="done__label">{action}</span>
        <span className="kbd">⌘⏎</span>
      </button>
    )}
  </footer>
);

export const LambdaScreen = ({
  lambda,
  state,
  rails,
  tick,
  onOpenPod,
  onOpenTicket,
  onPlanNew,
  onRename,
  onDelete,
  starred,
  onStar,
}: {
  lambda: Lambda;
  state: AppState;
  rails: Rails;
  tick: number;
  /** Its planning chat (or a computer's page). */
  onOpenPod: (podId: string) => void;
  onOpenTicket: (projectId: string, ticketId: string) => void;
  /** A new planning chat about it: the New page with this text. */
  onPlanNew: (projectId: string | null, text: string) => void;
  onRename: (podId: string, title: string) => void;
  onDelete: (podId: string) => void;
  /** It's in the sidebar's Favorites. */
  starred: boolean;
  onStar: () => void;
}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const ticket =
    lambda.tickets.find((one) => one.id === picked) ?? focusTicket(lambda);
  const ticketId = ticket?.id ?? lambda.ticketId;
  const { projectId } = lambda;
  const buildPodId =
    ticket !== null && 'podId' in ticket.where ? ticket.where.podId : null;
  const phase = pagePhase(lambda.phase);
  const [page, setPage] = useState<TicketPage | null>(null);
  const [detail, setDetail] = useState<BuildingPodDetail | null>(null);
  const [planning, setPlanning] = useState<PodDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const failed = (caught: unknown): void => setActionError(errorText(caught));
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState('');
  /** The Blocked item's option picked (null: its recommendation). */
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [planMore, setPlanMore] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [pair, setPair] = useState<OpenPair | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [madeFilter, setMadeFilter] = useState<MadeFilter>('all');
  const loadPage = useMemo(
    () => latestLoader<TicketPage>({ value: setPage, error: setError }),
    []
  );
  const loadDetail = useMemo(
    () =>
      latestLoader<BuildingPodDetail>({ value: setDetail, error: setError }),
    []
  );
  const loadPlanning = useMemo(
    () => latestLoader<PodDetail>({ value: setPlanning, error: setError }),
    []
  );
  const loadedAt = useRef<number | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Each app event ticks: read at most every few seconds, like a building pod.
  useEffect(() => {
    const read = (): void => {
      loadedAt.current = Date.now();

      if (projectId !== null && ticketId !== null) {
        void loadPage(api.ticketPage(projectId, ticketId));
      }

      if (buildPodId !== null) {
        void loadDetail(api.building(buildPodId));
      }

      if (lambda.planningPodId !== null) {
        void loadPlanning(api.pod(lambda.planningPodId));
      }
    };
    const wait = buildingRefreshIn(loadedAt.current, Date.now());

    if (wait === 0) {
      read();

      return undefined;
    }

    const timer = window.setTimeout(read, wait);

    return () => window.clearTimeout(timer);
  }, [
    loadPage,
    loadDetail,
    loadPlanning,
    projectId,
    ticketId,
    buildPodId,
    lambda.planningPodId,
    tick,
  ]);

  // Another ticket's page starts afresh.
  useEffect(() => {
    loadedAt.current = null;
    setPage(null);
    setDetail(null);
  }, [ticketId, buildPodId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);

    return () => window.clearInterval(id);
  }, []);

  // Each phase opens on its own rail: Ready on Tickets, building on Workflow…
  const { setRail } = rails;

  useEffect(() => {
    setRail(lambdaDefaultRail(phase));
  }, [lambda.key, phase, setRail]);

  // ⋯ closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const away = (event: MouseEvent): void => {
      if (
        menu.current !== null &&
        event.target instanceof Node &&
        !menu.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const ids: RailId[] = lambdaRailsOf(phase);
  const shown: RailId | null =
    rails.rail === null
      ? null
      : ids.includes(rails.rail)
      ? rails.rail
      : lambdaDefaultRail(phase);
  const expanded = rails.expanded && shown !== null;
  const project =
    state.lambda?.projects.find((one) => one.id === projectId)?.name ??
    projectId ??
    '';
  const qaOn =
    lambda.phase === 'qa' ||
    (detail?.steps.some((step) => step.id === 'review' && step.off !== true) ??
      false);
  const strip = stripStepOf(lambda.phase);

  // What waits on the owner here, with its message on the building pod.
  const waitingOn = (tag: 'blocked' | 'review') =>
    lambda.needsYou.find(
      (entry) =>
        entry.tag === tag &&
        entry.ticketId === ticketId &&
        entry.messageId !== undefined
    );
  const blockedEntry = waitingOn('blocked');
  const reviewEntry = waitingOn('review');
  const messageOf = (messageId: string | undefined) =>
    messageId === undefined
      ? undefined
      : detail?.thread.find((message) => message.id === messageId);
  const blockedMessage = messageOf(blockedEntry?.messageId);
  const blockedRun = detail?.building.runs.find(
    (run) =>
      run.blocked !== undefined &&
      run.blocked.messageId === blockedEntry?.messageId
  )?.blocked;
  const reviewMessage = messageOf(reviewEntry?.messageId);

  const runs = detail?.building.runs.filter((run) => run.id === ticketId) ?? [];
  const lastRun = runs.at(-1);
  const builtMs =
    lastRun === undefined
      ? null
      : (lastRun.shippedAt === undefined
          ? now
          : Date.parse(lastRun.shippedAt)) - Date.parse(lastRun.startedAt);
  const commit = page?.shipped?.hash ?? null;
  const divider = phaseDivider(lambda, ticket, now, {
    commit,
    builtMs: phase === 'qa' || phase === 'shipped' ? builtMs : null,
  });
  const planningMessages = (planning?.thread ?? []).filter(
    (message) => message.from !== 'system' && message.text.trim() !== ''
  );
  const checkpoints = (planning?.questions ?? []).filter(
    (question) => question.kind === 'checkpoint'
  ).length;
  const activity =
    page === null
      ? []
      : ticketActivity(page.events, stepDisplayName, formatMinutes);
  const talk = page?.talk ?? [];
  const progress = phase === 'shipped' ? epicProgress(lambda) : null;
  const action = mainAction(lambda);
  const description = page?.ticket.description.trim() ?? '';
  const summary = page?.summary.state === 'ready' ? page.summary : null;
  const queue =
    ticket === null ? null : queuePlace(ticket, detail?.typicalMs ?? null);
  const ahead = ticket?.where.kind === 'queued' ? ticket.where.ahead : [];
  const computer =
    ticket !== null && 'computer' in ticket.where
      ? ticket.where.computer
      : null;
  const visualRounds =
    ticketId === null ? [] : detail?.visual?.[ticketId] ?? [];
  const shots =
    ticketId === null
      ? []
      : Object.entries(detail?.screenshots ?? {})
          .filter(([key]) => key.startsWith(`${ticketId}/`))
          .flatMap(([, list]) => list);
  const ttsPod = buildPodId ?? lambda.planningPodId;
  const buildingNow = detail === null ? null : currentRun(detail.building);

  const sections: ReadAloudSection[] = (() => {
    switch (shown) {
      case 'tickets':
        return [
          ...(ahead.length === 0
            ? []
            : [
                {
                  id: 'ahead',
                  text: `Ahead of it: ${ahead
                    .map((one) => one.title)
                    .join(', ')}.`,
                },
              ]),
          ...(description === '' ? [] : [{ id: 'ticket', text: description }]),
        ];
      case 'workflow':
        return blockedMessage === undefined
          ? []
          : [
              {
                id: 'question',
                text:
                  blockedRun === undefined
                    ? blockedMessage.text
                    : `${blockedRun.problem} Recommended: ${blockedRun.recommendation}`,
              },
            ];
      case 'review':
        return reviewMessage === undefined
          ? []
          : [{ id: 'review', text: reviewMessage.text }];
      case 'summary':
        return [
          {
            id: 'changed',
            text:
              summary?.after ??
              (description === '' ? lambda.title : description),
          },
        ];
      case 'plan':
        return summary === null
          ? description === ''
            ? []
            : [{ id: 'plan', text: description }]
          : [
              { id: 'today', text: summary.today },
              { id: 'after', text: summary.after },
            ];
      default:
        return [];
    }
  })();
  const read = useReadAloud(ttsPod, sections);
  const readSection = (id: string) => () => read.playSection(id);

  const sendTalk = (): void => {
    const text = draft.trim();

    if (text === '' || busy || projectId === null || ticketId === null) {
      return;
    }

    // While it's blocked, words in the box answer the block.
    if (buildPodId !== null && blockedEntry?.messageId !== undefined) {
      void answerItem(buildPodId, blockedEntry.messageId, text).then(() =>
        setDraft('')
      );

      return;
    }

    setBusy(true);
    setActionError(null);
    api
      .talkTicket(projectId, ticketId, text)
      .then(() => {
        setDraft('');

        return loadPage(api.ticketPage(projectId, ticketId));
      })
      .catch(failed)
      .finally(() => setBusy(false));
  };

  /** An answer on a building item: to its pod, about that item. */
  const answerItem = (
    podId: string,
    messageId: string,
    text: string
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);

    return api
      .chat(podId, text, messageId)
      .then(() => loadDetail(api.building(podId)))
      .catch(failed)
      .finally(() => setBusy(false));
  };

  const answerBlocker = (): void => {
    const text = blockerAnswer(blockedRun, choice, answer);

    if (
      text === '' ||
      buildPodId === null ||
      blockedEntry?.messageId === undefined
    ) {
      return;
    }

    void answerItem(buildPodId, blockedEntry.messageId, text).then(() =>
      setAnswer('')
    );
  };

  const approve = (): void => {
    if (buildPodId !== null && reviewEntry?.messageId !== undefined) {
      void answerItem(buildPodId, reviewEntry.messageId, 'Approved: ship it.');
    }
  };

  const sendBack = (): void => {
    const text = draft.trim();

    if (buildPodId === null || reviewEntry?.messageId === undefined) {
      return;
    }

    if (text === '') {
      setActionError('Say what should change in the box first.');

      return;
    }

    void answerItem(
      buildPodId,
      reviewEntry.messageId,
      `Send back: ${text}`
    ).then(() => setDraft(''));
  };

  const startPlanMore = (): void => {
    if (lambda.planningPodId === null) {
      onPlanNew(
        projectId,
        ticketId === null
          ? `Plan more on ${lambda.title}: `
          : `Plan more on ${ticketId} ${lambda.title}: `
      );

      return;
    }

    setPlanMore('');
  };

  const sendPlanMore = (): void => {
    const text = (planMore ?? '').trim();

    if (
      text === '' ||
      projectId === null ||
      lambda.planningPodId === null ||
      busy
    ) {
      return;
    }

    const { planningPodId } = lambda;
    setBusy(true);
    api
      .planMore(
        projectId,
        planningPodId,
        ticketId === null ? [] : [ticketId],
        text
      )
      .then(() => {
        setPlanMore(null);
        onOpenPod(planningPodId);
      })
      .catch(failed)
      .finally(() => setBusy(false));
  };

  const planNext = (): void =>
    onPlanNew(projectId, `What's next after ${lambda.title}: `);

  const reportProblem = (): void => {
    const text = (problem ?? '').trim();

    if (text === '' || projectId === null || busy) {
      return;
    }

    setBusy(true);
    api
      .newTicket(projectId, {
        title: text.split('\n')[0]?.slice(0, 120) ?? text,
        description: `${text}\n\nFound after ${
          ticketId ?? lambda.title
        } shipped.`,
        status: 'planning',
        labels: ['Bug'],
      })
      .then(() => setProblem(null))
      .catch(failed)
      .finally(() => setBusy(false));
  };

  const runAction = (): void => {
    switch (action) {
      case 'Plan more':
        startPlanMore();

        break;
      case 'Answer, and carry on':
        answerBlocker();

        break;
      case 'Approve and merge':
        approve();

        break;
      case "Plan what's next":
        planNext();

        break;
      default:
    }
  };

  // ⌘⏎ runs the main action, from anywhere on the page.
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        runActionRef.current();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const player = (
    <PlayerBar read={read} action={action} busy={busy} onAction={runAction} />
  );
  const compose = COMPOSE[phase];
  const buildingSummary = state.pods.find(
    (summaryOf) => summaryOf.pod.id === buildPodId
  );
  const computerPaused = buildingSummary?.pod.status === 'paused';

  return (
    <div
      className="workspace"
      style={{
        gridTemplateColumns:
          shown === null || expanded
            ? 'minmax(0, 1fr)'
            : `minmax(${MIN_CHAT}px, 1fr) ${rails.width}px`,
      }}
    >
      <main className="main lambda-page" hidden={expanded}>
        <div className="toolbar lambda-page__toolbar">
          <h1 className="toolbar__title">
            {lambda.title}
            <span className="lambda-page__where">{project}</span>
            {projectId !== null && ticketId !== null && (
              <button
                type="button"
                className="toolbar__ticket"
                title="Open the ticket"
                onClick={() => onOpenTicket(projectId, ticketId)}
              >
                {ticketId}
              </button>
            )}
            <StarButton on={starred} onToggle={onStar} what="Lambda" />
          </h1>
          <div className="toolbar__right">
            {phase === 'queued' && (
              <button
                type="button"
                className="lambda-page__button"
                onClick={startPlanMore}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
                </svg>
                Plan more
              </button>
            )}
            {phase === 'shipped' && (
              <button
                type="button"
                className="lambda-page__button"
                onClick={() => setProblem('')}
              >
                Report a problem
              </button>
            )}
            <div className="lambda-page__menu" ref={menu}>
              <button
                type="button"
                className="lambda-page__more"
                aria-label="More"
                title="Pause, rename, delete…"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
              {menuOpen && (
                <div
                  className="context-menu lambda-page__menu-list"
                  role="menu"
                >
                  {lambda.planningPodId !== null && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);

                        if (lambda.planningPodId !== null) {
                          onOpenPod(lambda.planningPodId);
                        }
                      }}
                    >
                      Open the planning chat
                    </button>
                  )}
                  {projectId !== null && ticketId !== null && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenTicket(projectId, ticketId);
                      }}
                    >
                      Open the ticket
                    </button>
                  )}
                  {buildPodId !== null && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        (computerPaused
                          ? api.resume(buildPodId)
                          : api.pause(buildPodId)
                        ).catch(failed);
                      }}
                    >
                      {computerPaused
                        ? `Resume ${computer ?? 'the computer'}`
                        : `Pause ${computer ?? 'the computer'}`}
                    </button>
                  )}
                  {lambda.planningPodId !== null && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          const title = window.prompt(
                            'Rename this Lambda',
                            lambda.title
                          );

                          if (
                            title !== null &&
                            title.trim() !== '' &&
                            lambda.planningPodId !== null
                          ) {
                            onRename(lambda.planningPodId, title.trim());
                          }
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="context-menu__danger"
                        onClick={() => {
                          setMenuOpen(false);

                          if (
                            lambda.planningPodId !== null &&
                            window.confirm(
                              `Delete "${lambda.title}"? Its planning chat goes; its tickets stay.`
                            )
                          ) {
                            onDelete(lambda.planningPodId);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <RailSwitcher
              rails={rails}
              shown={shown}
              badges={{
                workflow: blockedEntry !== undefined && shown !== 'workflow',
                review: reviewEntry !== undefined && shown !== 'review',
              }}
              ids={ids}
            />
          </div>
        </div>
        <div className="lambda-page__strip">
          <PhaseStrip at={strip} qaOn={qaOn} />
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

        <section className="lambda-thread" aria-label="Conversation">
          <div className="lambda-thread__log">
            {lambda.planningPodId !== null && (
              <button
                type="button"
                className="lambda-thread__fold"
                aria-expanded={foldOpen}
                onClick={() =>
                  lambda.planningPodId !== null && !foldOpen
                    ? setFoldOpen(true)
                    : setFoldOpen(!foldOpen)
                }
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                  className={foldOpen ? 'lambda-thread__caret--open' : ''}
                >
                  <path d="M8 5l9 7-9 7z" />
                </svg>
                {foldedLine(strip, planningMessages.length, checkpoints)}
              </button>
            )}
            {foldOpen && (
              <div className="lambda-thread__folded">
                {planningMessages.slice(-12).map((message) => (
                  <div
                    key={message.id}
                    className={
                      message.from === 'human'
                        ? 'msg msg--you'
                        : 'msg msg--claude'
                    }
                  >
                    {message.from !== 'human' && (
                      <span className="msg__label">Lambda</span>
                    )}
                    <Markdown text={message.text} />
                  </div>
                ))}
                {lambda.planningPodId !== null && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      lambda.planningPodId !== null &&
                      onOpenPod(lambda.planningPodId)
                    }
                  >
                    Open the whole planning chat ›
                  </button>
                )}
              </div>
            )}
            {divider !== '' && (
              <div className="lambda-thread__divider" role="separator">
                <span>{divider}</span>
              </div>
            )}
            {activity.length > 0 && (
              <div className="lambda-thread__activity">
                {activity.map((entry) => (
                  <div
                    key={`${entry.at}/${entry.text}`}
                    className="lambda-thread__line"
                  >
                    <span aria-hidden="true">•</span>
                    <span>
                      <strong>{entry.who}</strong> {entry.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {talk.map((message) =>
              message.from === 'you' ? (
                <div key={message.at} className="msg msg--you">
                  <Markdown text={message.text} />
                </div>
              ) : (
                <div key={message.at} className="lambda-thread__said">
                  <span className="lambda-thread__who">
                    {TALKERS[message.from]} · {ago(message.at, now)}
                  </span>
                  <Markdown text={message.text} />
                </div>
              )
            )}
            {blockedEntry !== undefined && (
              <BlockerCard
                blocker={blockedRun}
                computer={computer}
                fallback={
                  blockedMessage === undefined ? (
                    <p className="muted">Loading the question…</p>
                  ) : (
                    <div className="lambda-card__body">
                      <Markdown text={blockedMessage.text} />
                    </div>
                  )
                }
                choice={choice}
                words={answer}
                busy={busy}
                onChoice={setChoice}
                onWords={setAnswer}
                onAnswer={answerBlocker}
                onPlanMore={startPlanMore}
              />
            )}
            {reviewMessage !== undefined && (
              <ChatLine message={reviewMessage} />
            )}
            {progress !== null && (
              <article className="lambda-card">
                <strong>{progress.line}</strong>
                <span className="muted">{progress.rest}</span>
                <span className="lambda-card__actions">
                  {projectId !== null && lambda.ticketId !== null && (
                    <button
                      type="button"
                      className="lambda-page__button"
                      onClick={() =>
                        lambda.ticketId !== null &&
                        onOpenTicket(projectId, lambda.ticketId)
                      }
                    >
                      Open the epic
                    </button>
                  )}
                  <button
                    type="button"
                    className="lambda-page__button"
                    onClick={planNext}
                  >
                    Plan what&apos;s next
                  </button>
                </span>
              </article>
            )}
            {planMore !== null && (
              <article className="lambda-card">
                <strong>Plan more</strong>
                <span className="muted">
                  Back to its planning chat with this. Its tickets go back to
                  Planning until you approve again.
                </span>
                <textarea
                  className="lambda-card__answer"
                  rows={3}
                  autoFocus
                  value={planMore}
                  placeholder="What should the plan cover?"
                  aria-label="What should the plan cover?"
                  onChange={(event) => setPlanMore(event.target.value)}
                />
                <span className="lambda-card__actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || planMore.trim() === ''}
                    onClick={sendPlanMore}
                  >
                    Plan more
                  </button>
                  <button
                    type="button"
                    className="lambda-page__button"
                    onClick={() => setPlanMore(null)}
                  >
                    Cancel
                  </button>
                </span>
              </article>
            )}
            {problem !== null && (
              <article className="lambda-card">
                <strong>Report a problem</strong>
                <span className="muted">
                  A new ticket in Planning, labelled Bug.
                </span>
                <textarea
                  className="lambda-card__answer"
                  rows={3}
                  autoFocus
                  value={problem}
                  placeholder="What's wrong?"
                  aria-label="What's wrong?"
                  onChange={(event) => setProblem(event.target.value)}
                />
                <span className="lambda-card__actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || problem.trim() === ''}
                    onClick={reportProblem}
                  >
                    Make the ticket
                  </button>
                  <button
                    type="button"
                    className="lambda-page__button"
                    onClick={() => setProblem(null)}
                  >
                    Cancel
                  </button>
                </span>
              </article>
            )}
          </div>
          <footer className="lambda-compose">
            <label>
              <span className="lambda-compose__to">
                {blockedEntry === undefined
                  ? compose.label
                  : 'To Lambda · while it’s blocked, this answers the block'}
              </span>
              <textarea
                rows={2}
                value={draft}
                placeholder={compose.placeholder}
                readOnly={busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.metaKey &&
                    !event.ctrlKey
                  ) {
                    event.preventDefault();
                    sendTalk();
                  }
                }}
              />
            </label>
          </footer>
        </section>
      </main>

      {shown === 'plan' && (
        <RailHost rails={rails} title="Plan">
          <div className="rail__scroll lambda-rail">
            {summary !== null ? (
              <>
                <Heading onRead={readSection('today')}>Today</Heading>
                <p className="lambda-rail__text">{summary.today}</p>
                <Heading onRead={readSection('after')}>After</Heading>
                <p className="lambda-rail__text">{summary.after}</p>
              </>
            ) : (
              description !== '' && (
                <>
                  <Heading onRead={readSection('plan')}>The ticket</Heading>
                  <div className="lambda-rail__text">
                    <Markdown text={description} />
                  </div>
                </>
              )
            )}
            {lambda.tickets.length > 1 && (
              <>
                <Heading>Its tickets</Heading>
                <ul className="lambda-rail__list">
                  {lambda.tickets.map((one) => (
                    <li key={one.id}>
                      <button
                        type="button"
                        className={`lambda-rail__ticket${
                          one.id === ticketId ? ' lambda-rail__ticket--on' : ''
                        }`}
                        onClick={() => setPicked(one.id)}
                      >
                        <TicketMark where={one.where} />
                        <span className="lambda-rail__grow">{one.title}</span>
                        <span className="lambda-rail__note">{one.id}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {lambda.planningPodId !== null && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  lambda.planningPodId !== null &&
                  onOpenPod(lambda.planningPodId)
                }
              >
                Open the planning chat ›
              </button>
            )}
          </div>
          {player}
        </RailHost>
      )}

      {shown === 'tickets' && (
        <RailHost rails={rails} title="Tickets">
          <div className="rail__scroll lambda-rail">
            {queue !== null && (
              <div className="lambda-rail__place">
                <div className="lambda-rail__big">{queue.headline}</div>
                <div className="lambda-rail__muted">{queue.detail}</div>
              </div>
            )}
            {ticket?.where.kind === 'queued' && (
              <>
                <Heading
                  onRead={ahead.length > 0 ? readSection('ahead') : undefined}
                >
                  Ahead of it
                </Heading>
                {ahead.map((one, index) => {
                  const current =
                    buildingNow?.id === one.id ? buildingNow : null;
                  const firstQueued =
                    index === (buildingNow?.id === ahead[0]?.id ? 1 : 0);

                  return (
                    <div key={one.id} className="lambda-rail__row">
                      <TicketMark
                        where={
                          current === null
                            ? { kind: 'waiting' }
                            : {
                                kind: 'building',
                                step: current.step,
                                startedAt: '',
                                computer: '',
                                podId: '',
                              }
                        }
                      />
                      <span className="lambda-rail__grow">{one.title}</span>
                      <span className="lambda-rail__note">
                        {current !== null
                          ? stepDisplayName(current.step).toLowerCase()
                          : firstQueued
                          ? 'next'
                          : ''}
                      </span>
                    </div>
                  );
                })}
                <div className="lambda-rail__row lambda-rail__row--this">
                  <TicketMark where={{ kind: 'waiting' }} />
                  <span className="lambda-rail__grow">{ticket.title}</span>
                  <span className="lambda-rail__note">this one</span>
                </div>
                {ahead.length > 0 && projectId !== null && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      const before = ahead.at(-2);
                      api
                        .moveTicket(projectId, ticket.id, before?.id ?? null)
                        .catch(failed);
                    }}
                  >
                    Move it up
                  </button>
                )}
              </>
            )}
            {description !== '' && (
              <>
                <Heading onRead={readSection('ticket')}>The ticket</Heading>
                <div className="lambda-rail__text">
                  <Markdown text={description} />
                </div>
              </>
            )}
          </div>
          {player}
        </RailHost>
      )}

      {shown === 'workflow' && (
        <RailHost rails={rails} title="Workflow">
          <div className="rail__scroll lambda-rail">
            {computer !== null && (
              <div className="lambda-rail__muted">
                On {computer}
                {builtMs !== null && phase === 'building'
                  ? ` · this ticket ${formatMinutes(builtMs)}`
                  : ''}
              </div>
            )}
            {detail === null || ticketId === null ? (
              <p className="rail__empty">
                {buildPodId === null
                  ? 'No computer has taken it yet.'
                  : 'Loading…'}
              </p>
            ) : (
              <WorkflowRail
                detail={detail}
                now={now}
                ticketId={ticketId}
                onShot={setShot}
                onPair={setPair}
              />
            )}
            {blockedRun !== undefined ? (
              <>
                <Heading onRead={readSection('question')}>The question</Heading>
                <p className="lambda-rail__text">
                  {blockedRun.problem} Recommended: {blockedRun.recommendation}
                </p>
              </>
            ) : (
              blockedMessage !== undefined && (
                <>
                  <Heading onRead={readSection('question')}>
                    The question
                  </Heading>
                  <div className="lambda-rail__text">
                    <Markdown text={blockedMessage.text} />
                  </div>
                </>
              )
            )}
          </div>
          {player}
        </RailHost>
      )}

      {shown === 'review' && (
        <RailHost rails={rails} title="Review">
          <div className="rail__scroll lambda-rail">
            <Heading
              onRead={
                reviewMessage === undefined ? undefined : readSection('review')
              }
            >
              Pictures
            </Heading>
            {visualRounds.length === 0 && shots.length === 0 ? (
              <p className="lambda-rail__muted">No pictures for this one.</p>
            ) : (
              <div className="lambda-rail__pictures">
                {buildPodId !== null && ticketId !== null && (
                  <VisualPairs
                    podId={buildPodId}
                    ticketId={ticketId}
                    rounds={visualRounds}
                    onPair={setPair}
                  />
                )}
              </div>
            )}
            <button
              type="button"
              className="link-button"
              onClick={() => rails.setRail('made')}
            >
              All pictures, in Made ›
            </button>
            <Heading>Checks</Heading>
            <div className="lambda-rail__checks">
              <span>
                {page?.verdict === 'COMPLETE' ? '✓' : '○'} Check ticket:{' '}
                {page?.verdict ?? 'not yet'}
              </span>
              {activity
                .filter((entry) => entry.text.includes('✓'))
                .slice(-1)
                .map((entry) => (
                  <span key={entry.at}>{entry.text}</span>
                ))}
            </div>
            <button
              type="button"
              className="lambda-page__button lambda-rail__send-back"
              disabled={busy || reviewEntry === undefined}
              onClick={sendBack}
            >
              Send back
            </button>
          </div>
          {player}
        </RailHost>
      )}

      {shown === 'summary' && (
        <RailHost rails={rails} title="Summary">
          <div className="rail__scroll lambda-rail">
            <div className="lambda-rail__facts">
              <div className="lambda-rail__fact">
                <span>Commit</span>
                <code>{commit === null ? '—' : commit.slice(0, 7)}</code>
              </div>
              <div className="lambda-rail__fact">
                <span>Build time</span>
                <span>{builtMs === null ? '—' : formatMinutes(builtMs)}</span>
              </div>
              <div className="lambda-rail__fact">
                <span>Files</span>
                <span>
                  {page?.shipped === null || page?.shipped === undefined
                    ? '—'
                    : filesLine(page.shipped.files)}
                </span>
              </div>
              <div className="lambda-rail__fact">
                <span>Built on</span>
                <span>{computer ?? '—'}</span>
              </div>
            </div>
            <Heading onRead={readSection('changed')}>What changed</Heading>
            <p className="lambda-rail__text">
              {summary?.after ??
                (description === '' ? lambda.title : description)}
            </p>
            {(page?.shipped?.files ?? []).map((file) => (
              <div key={file.path} className="lambda-rail__file">
                <span className="lambda-rail__added">+{file.added}</span>
                {file.removed > 0 && (
                  <span className="lambda-rail__removed">−{file.removed}</span>
                )}
                <span>{file.path}</span>
              </div>
            ))}
          </div>
          {player}
        </RailHost>
      )}

      {shown === 'made' && (
        <RailHost rails={rails} title="Made">
          <div className="rail__scroll lambda-rail">
            <div className="lambda-rail__chips" role="group" aria-label="Phase">
              {MADE_FILTERS.map((one) => (
                <button
                  key={one}
                  type="button"
                  aria-pressed={madeFilter === one}
                  className={`lambda-rail__chip${
                    madeFilter === one ? ' lambda-rail__chip--on' : ''
                  }`}
                  onClick={() => setMadeFilter(one)}
                >
                  {one === 'all'
                    ? 'All'
                    : one === 'planning'
                    ? 'Planning'
                    : 'Building'}
                </button>
              ))}
            </div>
            {madeFilter !== 'planning' &&
              buildPodId !== null &&
              ticketId !== null &&
              visualRounds.length > 0 && (
                <>
                  <h3 className="lambda-rail__group">
                    Building · visual check, {visualRounds.length}{' '}
                    {visualRounds.length === 1 ? 'round' : 'rounds'}
                  </h3>
                  <VisualPairs
                    podId={buildPodId}
                    ticketId={ticketId}
                    rounds={visualRounds}
                    onPair={setPair}
                  />
                </>
              )}
            {madeFilter !== 'planning' && shots.length > 0 && (
              <>
                <h3 className="lambda-rail__group">Building · tests</h3>
                <div className="lambda-rail__shots">
                  {shots.map((one) => (
                    <button
                      key={`${one.attempt}/${one.file}`}
                      type="button"
                      className="build-shot"
                      title={one.conclusion}
                      onClick={() => setShot(one)}
                    >
                      <img src={screenshotUrl(buildPodId ?? '', one)} alt="" />
                    </button>
                  ))}
                </div>
              </>
            )}
            {visualRounds.length === 0 &&
              shots.length === 0 &&
              (madeFilter === 'building' || lambda.planningPodId === null) && (
                <p className="lambda-rail__muted">
                  Nothing made here yet: designs, prototypes and the
                  build&apos;s pictures show up as they&apos;re made.
                </p>
              )}
            {madeFilter !== 'building' && lambda.planningPodId !== null && (
              <>
                <h3 className="lambda-rail__group">
                  Planning · designs and prototypes
                </h3>
                <ViewerProvider
                  podId={lambda.planningPodId}
                  refreshKey={planning?.thread.length ?? 0}
                  onAddToChat={(text) => setDraft(`${draft}${text}\n`)}
                >
                  <MadeRail thread={planning?.thread ?? []} />
                </ViewerProvider>
              </>
            )}
          </div>
        </RailHost>
      )}

      {shown === 'agents' && (
        <RailHost
          rails={rails}
          title={`Agents · ${
            buildPodId !== null ? computer ?? 'Building' : 'Planning'
          }`}
          dark
        >
          {buildPodId !== null && detail !== null ? (
            <WindowPicker
              podId={buildPodId}
              project={detail.pod.projectId ?? project}
              agents={detail.windows}
              labelOf={buildingWindowName}
              fallback="manager"
              onError={failed}
            />
          ) : lambda.planningPodId !== null && planning !== null ? (
            <WindowPicker
              podId={lambda.planningPodId}
              project={planning.pod.projectId ?? project}
              agents={planning.windows}
              labelOf={PLANNING_WINDOWS}
              fallback="dev"
              onError={failed}
            />
          ) : (
            <p className="rail__empty">Nothing running for it.</p>
          )}
        </RailHost>
      )}

      {shot !== null && buildPodId !== null && (
        <ScreenshotViewer
          podId={buildPodId}
          shot={shot}
          onClose={() => setShot(null)}
        />
      )}
      {pair !== null && buildPodId !== null && (
        <VisualPairViewer
          podId={buildPodId}
          open={pair}
          onClose={() => setPair(null)}
        />
      )}
    </div>
  );
};
