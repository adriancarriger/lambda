import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import type {
  AutonomousDecision,
  Pod,
  Question,
  Screen,
  ThreadMessage,
} from '../../pod-store';
import {
  type Timeline,
  decisionCardKey,
  screenCardKey,
} from '../shared/cardHistory';
import {
  checkpointGoal,
  checkpointTip,
  phaseName,
  phaseTip,
} from '../shared/phases';
import { podName } from '../shared/podName';
import {
  engineeringDecisionSpeech,
  flowSectionKey,
  screenSectionKey,
  screenStatesSpeech,
  ticketSectionKey,
} from '../shared/speech';
import { CardMark } from './CardVersions';
import {
  Changes,
  Proposal,
  SuggestedJudgements,
  Understood,
} from './CheckpointExtras';
import { LedTo, OriginBlock } from './ItemContext';
import { LaneTag } from './LaneTag';
import { Markdown } from './Message';
import { fileSrc, groupOf, useViewer } from './Prototypes';
import { SpeakerIcon } from './SpeakerIcon';
import { Tip } from './Tip';
import {
  type SectionKey,
  type UxView,
  loadUxView,
  missingPictureText,
  numberedDecisionsOf,
  saveUxView,
  screenDecisionIds,
  screenView,
} from './speech';
import type { ItemTimes } from './useActiveTime';

interface Props {
  pod: Pod;
  question: Question;
  position: string;
  playing: SectionKey | null;
  onPlaySection: (key: SectionKey) => void;
  /** The pod's whole thread and questions — for the chat and the links. */
  thread: ThreadMessage[];
  questions: Question[];
  decisions: AutonomousDecision[];
  onOpenItem: (qid: string) => void;
  /** Shown when the item was opened from a link rather than the inbox. */
  status?: string;
  /** On-demand audio outside the item's sequence (a screen's edge cases). */
  extra: { key: string; loading: boolean } | null;
  onPlayExtra: (key: string, text: string) => void;
  /** The option Done goes with (the recommendation until they pick another). */
  pickedOption?: string;
  /** Clicking an option picks it. */
  onPickOption?: (optionId: string) => void;
  /** Ticks on the suggested judgements (CP5), saved as they make them. */
  onKeepJudgements: (indices: number[]) => void;
  /**
   * Messages about this item in the chat beside the card (the card is the
   * document; the conversation lives there) — and a way to jump to them.
   */
  discussed: number;
  onShowInChat: () => void;
  /** Time on this item, beside "Discussed in chat". */
  timeNote?: ReactNode;
  /** Above everything: e.g. "Viewing v2 of 4". */
  notice?: ReactNode;
  /** An earlier version: shown as it was, nothing on it can be used. */
  readOnly?: boolean;
  /**
   * The checkpoint's versions (cardHistory.ts), the one on screen, and a way
   * to show another — each card says when it last changed and opens them.
   */
  versions?: {
    timeline: Timeline;
    viewing: number;
    onView: (version: number | null, anchor: string) => void;
  };
  /** Active time on this item and on each card in it. */
  times?: ItemTimes;
}

const Section = ({
  sectionKey,
  label,
  playing,
  onPlay,
  children,
}: {
  sectionKey: SectionKey;
  label: string;
  playing: SectionKey | null;
  onPlay: (key: SectionKey) => void;
  children: ReactNode;
}) => (
  <section
    className={`section${playing === sectionKey ? ' section--playing' : ''}`}
    data-section={sectionKey}
  >
    <header>
      <h3>{label}</h3>
      <button
        className="icon"
        type="button"
        title={`Play ${label.toLowerCase()}`}
        onClick={() => onPlay(sectionKey)}
      >
        <SpeakerIcon />
      </button>
    </header>
    {children}
  </section>
);

/**
 * A screen's pictures, per situation: today's screenshot beside the design
 * still, its numbered markers explained underneath. Shown, never spoken. The
 * alt names the file's place, so a picture deleted after posting still says
 * what it was.
 */
/** A picture of the pod's: a click opens the lightbox, every picture it made. */
const PodPicture = ({
  podId,
  file,
  alt,
}: {
  podId: string;
  file: string;
  alt: string;
}) => {
  const viewer = useViewer();
  const image = (
    <img className="screen__picture" src={fileSrc(podId, file)} alt={alt} />
  );

  return viewer === null || viewer.podId !== podId ? (
    image
  ) : (
    <button
      type="button"
      className="screen__picture-button"
      title="Open — ← → for every picture"
      onClick={() => viewer.openPicture(file)}
    >
      {image}
    </button>
  );
};

/** Try it: the screen's newest saved prototype, opened over the inbox. */
const TryScreen = ({ podId, screen }: { podId: string; screen: Screen }) => {
  const viewer = useViewer();
  const slug = (screen.pictures ?? [])
    .flatMap((picture) => [picture.after, picture.before])
    .map((file) => /^designs\/([a-z0-9-]+)\//.exec(file ?? '')?.[1])
    .find((found) => found !== undefined);
  const newest =
    slug === undefined || viewer === null || viewer.podId !== podId
      ? undefined
      : groupOf(viewer.made, slug)?.versions[0];

  return viewer === null || newest === undefined ? null : (
    <button
      type="button"
      className="link-button"
      data-testid="screen-try-it"
      onClick={() =>
        viewer.openPrototype({ slug: newest.slug, version: newest.version })
      }
    >
      ⤢ Try it
    </button>
  );
};

const ScreenPictures = ({
  podId,
  screen,
}: {
  podId: string;
  screen: Screen;
}) => (
  <>
    {(screen.pictures ?? []).map((picture) => (
      <div className="screen__situation" key={picture.situation}>
        <h4 className="screen__situation-title">{picture.situation}</h4>
        <div className="screen__compare">
          {(['before', 'after'] as const).map((side) => {
            const file = picture[side];

            return (
              <figure key={side}>
                <figcaption>
                  {side === 'before' ? 'Before' : 'After'}
                </figcaption>
                {file === undefined ? (
                  <p className="muted">{missingPictureText(side, screen)}</p>
                ) : (
                  <PodPicture
                    podId={podId}
                    file={file}
                    alt={`${screen.name} — ${picture.situation}, ${side}`}
                  />
                )}
                {side === 'after' && picture.legend.length > 0 && (
                  <ol className="screen__legend">
                    {picture.legend.map((entry) => (
                      <li key={entry.n} value={entry.n}>
                        {entry.label}
                      </li>
                    ))}
                  </ol>
                )}
              </figure>
            );
          })}
        </div>
      </div>
    ))}
  </>
);

export const QuestionCard = ({
  pod,
  question,
  position,
  playing,
  onPlaySection,
  thread,
  questions,
  decisions,
  onOpenItem,
  status,
  extra,
  onPlayExtra,
  pickedOption,
  onPickOption,
  onKeepJudgements,
  discussed,
  onShowInChat,
  timeNote,
  notice,
  readOnly = false,
  versions,
  times,
}: Props) => {
  const isCheckpoint =
    question.kind === 'checkpoint' && question.checkpoint !== undefined;
  const cp = question.checkpoint?.cp;
  // In the checkpoint's own order: these numbers are what the owner refers to,
  // and the dev receives the same numbered list with their reply.
  const reviewed = numberedDecisionsOf(question, decisions);
  // Decisions a screen already shows are told under it, keeping their number.
  const onScreens = screenDecisionIds(question);
  const productListed = reviewed.filter(
    (decision) => decision.kind !== 'engineering' && !onScreens.has(decision.id)
  ).length;
  const productOnScreens = reviewed.filter(
    (decision) => decision.kind !== 'engineering' && onScreens.has(decision.id)
  ).length;
  // Details are opened per decision (click its headline); never read aloud.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The UX review's Pictures | ASCII switch, remembered across cards.
  const [uxView, setUxView] = useState<UxView>(loadUxView);
  const chooseUxView = (view: UxView): void => {
    setUxView(view);
    saveUxView(view);
  };
  /** A card's "changed v8 · 2m" and its list of versions. */
  const markOf = (cardKey: string, title: string): ReactNode =>
    versions === undefined ? null : (
      <CardMark
        cardKey={cardKey}
        title={title}
        timeline={versions.timeline}
        viewing={versions.viewing}
        onView={versions.onView}
        msOf={(shownIn) => times?.cardMs(cardKey, shownIn) ?? 0}
      />
    );
  /** The version on screen changed this card: tint it. */
  const changedHere = (cardKey: string): boolean =>
    versions !== undefined &&
    versions.viewing > 1 &&
    versions.timeline.cards.get(cardKey)?.has(versions.viewing) === true;
  const toggle = (id: string): void =>
    setExpanded((previous) =>
      previous.has(id)
        ? new Set([...previous].filter((candidate) => candidate !== id))
        : new Set([...previous, id])
    );

  // The card is a live doc: when the dev edits it while the owner is looking,
  // the sections whose words changed (the innermost ones) light up briefly.
  const root = useRef<HTMLElement>(null);
  const seen = useRef<{ id: string; texts: Map<string, string> } | null>(null);

  useEffect(() => {
    const element = root.current;

    if (element === null) {
      return undefined;
    }

    const nodes = Array.from(
      element.querySelectorAll<HTMLElement>('[data-section]')
    );
    const textOf = (node: HTMLElement): string => node.innerText;
    const keyOf = (node: HTMLElement): string => node.dataset.section ?? '';
    const before = seen.current;
    seen.current = {
      id: question.id,
      texts: new Map(nodes.map((node) => [keyOf(node), textOf(node)])),
    };

    if (before === null || before.id !== question.id) {
      return undefined;
    }

    const changed = nodes.filter(
      (node) => before.texts.get(keyOf(node)) !== textOf(node)
    );
    const innermost = changed.filter(
      (node) => !changed.some((other) => other !== node && node.contains(other))
    );
    innermost.forEach((node) => node.classList.add('section--updated'));
    const timer = window.setTimeout(
      () =>
        innermost.forEach((node) => node.classList.remove('section--updated')),
      6000
    );

    return () => window.clearTimeout(timer);
  }, [question]);

  const refreshError = question.checkpoint?.refreshError;

  return (
    <article className="card" ref={root}>
      {notice}
      {refreshError !== undefined && !readOnly && (
        <details className="card__stale">
          <summary>
            The dev&apos;s last edit to this card didn&apos;t pass its checks —
            showing the last good version.
          </summary>
          <pre>{refreshError}</pre>
        </details>
      )}
      <div className="card__meta">
        <span className="kind">{isCheckpoint ? 'Checkpoint' : 'Decision'}</span>
        <span>{podName(pod)}</span>
        <span>·</span>
        <Tip
          className="phase-tip"
          text={
            isCheckpoint && cp !== undefined
              ? checkpointTip(cp, pod)
              : phaseTip(question.phase, pod)
          }
        >
          {isCheckpoint
            ? `Checkpoint ${cp ?? ''}`
            : `Phase ${question.phase} ${phaseName(question.phase, pod)}`}
        </Tip>
        {question.ticketId !== undefined && <span>· {question.ticketId}</span>}
        <span>· {question.id}</span>
        {status !== undefined && <span className="status-badge">{status}</span>}
        <span className="card__position">{position}</span>
      </div>
      {(timeNote !== undefined || discussed > 0) && (
        <div className="card__versions">
          {timeNote}
          {discussed > 0 && (
            <button
              type="button"
              className="link-button card__discussed"
              title="Jump to this item's part of the chat"
              onClick={onShowInChat}
            >
              Discussed in chat · {discussed}{' '}
              {discussed === 1 ? 'message' : 'messages'}
            </button>
          )}
        </div>
      )}
      {isCheckpoint && cp !== undefined && (
        <section
          className={`checkpoint-goal${
            playing === 'goal' ? ' section--playing' : ''
          }`}
          data-section="goal"
        >
          <span className="checkpoint-goal__label">This checkpoint</span>
          <p>{checkpointGoal(cp, pod).goal}</p>
        </section>
      )}

      {/* What's new first: how this got here, then the latest exchange. */}
      <div
        className={`card__context${
          playing === 'origin' ? ' section--playing' : ''
        }`}
        data-section="origin"
      >
        <OriginBlock
          question={question}
          questions={questions}
          thread={thread}
          onOpen={onOpenItem}
        />
      </div>
      <LedTo
        question={question}
        questions={questions}
        thread={thread}
        onOpen={onOpenItem}
      />

      <Section
        sectionKey="summary"
        label={isCheckpoint ? 'What happened' : 'Summary'}
        playing={playing}
        onPlay={onPlaySection}
      >
        <p className="lead">{question.summary}</p>
      </Section>

      {isCheckpoint &&
        question.checkpoint?.understood !== undefined &&
        question.checkpoint.understood !== '' && (
          <Understood
            text={question.checkpoint.understood}
            playing={playing}
            onPlay={onPlaySection}
          />
        )}

      {isCheckpoint && question.checkpoint?.changes !== undefined && (
        <Changes
          changes={question.checkpoint.changes}
          since={
            question.checkpoint.cp === 4
              ? 'you approved the split'
              : 'the UX review'
          }
          playing={playing}
          onPlay={onPlaySection}
        />
      )}

      {isCheckpoint &&
        question.checkpoint?.proposal !== undefined &&
        question.checkpoint.proposal.length > 0 && (
          <Proposal
            tickets={question.checkpoint.proposal}
            playing={playing}
            onPlay={onPlaySection}
            markOf={markOf}
            changedHere={changedHere}
          />
        )}

      {isCheckpoint &&
        question.checkpoint?.plan !== undefined &&
        question.checkpoint.plan.trim() !== '' && (
          <Section
            sectionKey="plan"
            label="The plan"
            playing={playing}
            onPlay={onPlaySection}
          >
            <p className="plan">{question.checkpoint.plan}</p>
          </Section>
        )}

      {isCheckpoint &&
        question.checkpoint?.screens !== undefined &&
        question.checkpoint.screens.length > 0 && (
          <section className="section">
            <header>
              <h3>Screens ({question.checkpoint.screens.length})</h3>
              <span
                className="ux-view"
                role="group"
                aria-label="Show the screens as"
              >
                {(['pictures', 'ascii'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    className={`toggle${uxView === view ? ' toggle--on' : ''}`}
                    aria-pressed={uxView === view}
                    data-testid={`ux-view-${view}`}
                    onClick={() => chooseUxView(view)}
                  >
                    {view === 'pictures' ? 'Pictures' : 'ASCII'}
                  </button>
                ))}
              </span>
              <button
                className="icon"
                type="button"
                title="Play the screens from the first"
                onClick={() => onPlaySection(screenSectionKey(0))}
              >
                <SpeakerIcon />
              </button>
            </header>
            {question.checkpoint.screens.map((screen, index, all) => {
              const key = screenSectionKey(index);
              const cardKey = screenCardKey(screen);
              // A flow's header goes before its first screen.
              const flow =
                screen.flow === undefined
                  ? undefined
                  : question.checkpoint?.flows?.[screen.flow];
              const startsFlow =
                flow !== undefined &&
                (index === 0 || all[index - 1]?.flow !== screen.flow);
              const flowSize = all.filter(
                (candidate) => candidate.flow === screen.flow
              ).length;

              return (
                <Fragment key={key}>
                  {startsFlow &&
                    flow !== undefined &&
                    screen.flow !== undefined && (
                      <header
                        className={`flow${
                          playing === flowSectionKey(screen.flow)
                            ? ' section--playing'
                            : ''
                        }`}
                        data-section={flowSectionKey(screen.flow)}
                      >
                        <div className="flow__title">
                          <span className="flow__label">
                            Flow {screen.flow + 1}
                          </span>
                          <strong>{flow.name}</strong>
                          <span className="muted">
                            {flowSize === 1
                              ? '1 screen'
                              : `${flowSize} screens`}
                          </span>
                          <button
                            className="icon"
                            type="button"
                            title="Play this flow"
                            onClick={() =>
                              screen.flow !== undefined &&
                              onPlaySection(flowSectionKey(screen.flow))
                            }
                          >
                            <SpeakerIcon />
                          </button>
                        </div>
                        <p>{flow.summary}</p>
                      </header>
                    )}
                  <article
                    data-section={key}
                    data-card={cardKey}
                    className={`screen${
                      playing === key ? ' screen--playing' : ''
                    }${changedHere(cardKey) ? ' card--changed-here' : ''}`}
                  >
                    <header className="screen__head">
                      <strong>
                        {index + 1}. {screen.name}
                      </strong>
                      <span className="kind kind--small">{screen.change}</span>
                      <span className="screen__meta">
                        <span className="muted">
                          Tickets {screen.tickets.join(', ')}
                        </span>
                        {markOf(cardKey, `${index + 1}. ${screen.name}`)}
                        <TryScreen podId={pod.id} screen={screen} />
                        {screen.prototypeUrl !== undefined && (
                          <a
                            href={screen.prototypeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="screen-prototype-link"
                          >
                            Open prototype ↗
                          </a>
                        )}
                        <button
                          className="icon"
                          type="button"
                          title="Play from this screen"
                          onClick={() => onPlaySection(key)}
                        >
                          <SpeakerIcon />
                        </button>
                      </span>
                    </header>
                    {screenView(uxView, screen) === 'pictures' ? (
                      <ScreenPictures podId={pod.id} screen={screen} />
                    ) : (
                      <div className="screen__compare">
                        <figure>
                          <figcaption>Before</figcaption>
                          {screen.before === undefined ? (
                            <p className="muted">
                              New screen — nothing here today.
                            </p>
                          ) : (
                            <pre className="ascii">{screen.before}</pre>
                          )}
                        </figure>
                        <figure>
                          <figcaption>After</figcaption>
                          {screen.after === undefined ? (
                            <p className="muted">Removed.</p>
                          ) : (
                            <pre className="ascii">{screen.after}</pre>
                          )}
                        </figure>
                      </div>
                    )}
                    <p>{screen.changes}</p>
                    {(screen.decisions ?? []).length > 0 && (
                      <ul className="screen__decisions">
                        {(screen.decisions ?? [])
                          .flatMap((id) =>
                            reviewed.flatMap((decision, number) =>
                              decision.id === id ? [{ decision, number }] : []
                            )
                          )
                          .map(({ decision, number }) => (
                            <li
                              key={decision.id}
                              data-card={decisionCardKey(decision.id)}
                              className={
                                changedHere(decisionCardKey(decision.id))
                                  ? 'card--changed-here'
                                  : undefined
                              }
                            >
                              <span className="screen__decision-head">
                                Decision {number + 1} · {decision.decision}
                              </span>
                              <dl className="today-after">
                                <dt>Why</dt>
                                <dd>{decision.why}</dd>
                                {decision.instead !== undefined && (
                                  <>
                                    <dt>Instead</dt>
                                    <dd className="muted">
                                      {decision.instead}
                                    </dd>
                                  </>
                                )}
                              </dl>
                            </li>
                          ))}
                      </ul>
                    )}
                    {screen.journey !== undefined && (
                      <details className="screen__journey">
                        <summary>The journey</summary>
                        <dl className="today-after journey">
                          <dt>Who</dt>
                          <dd>{screen.journey.who}</dd>
                          <dt>Before</dt>
                          <dd>{screen.journey.before}</dd>
                          <dt>Here</dt>
                          <dd>{screen.journey.here}</dd>
                          <dt>After</dt>
                          <dd>{screen.journey.after}</dd>
                        </dl>
                      </details>
                    )}
                    {screen.states !== undefined &&
                      screen.states.length > 0 && (
                        <>
                          <h4 className="screen__label">
                            States &amp; edge cases
                            <button
                              className="icon screen__extra"
                              type="button"
                              title={
                                extra?.key === `${key}-states`
                                  ? 'Stop'
                                  : "Play these edge cases (on demand — not part of the item's audio)"
                              }
                              onClick={() =>
                                onPlayExtra(
                                  `${key}-states`,
                                  screenStatesSpeech(index, screen)
                                )
                              }
                            >
                              {extra?.key === `${key}-states` ? (
                                extra.loading ? (
                                  '…'
                                ) : (
                                  '■'
                                )
                              ) : (
                                <SpeakerIcon />
                              )}
                            </button>
                          </h4>
                          <ul className="screen__states">
                            {screen.states.map((state) => (
                              <li key={state}>{state}</li>
                            ))}
                          </ul>
                        </>
                      )}
                  </article>
                </Fragment>
              );
            })}
          </section>
        )}

      {isCheckpoint &&
        question.checkpoint?.planTickets !== undefined &&
        question.checkpoint.planTickets.length > 0 && (
          <section className="section">
            <header>
              <h3>Tickets ({question.checkpoint.planTickets.length})</h3>
              <button
                className="icon"
                type="button"
                title="Play the tickets from the first"
                onClick={() => onPlaySection(ticketSectionKey(0))}
              >
                <SpeakerIcon />
              </button>
            </header>
            <ol className="plan-tickets">
              {question.checkpoint.planTickets.map((ticket, index) => {
                const key = ticketSectionKey(index);

                return (
                  <li
                    key={ticket.id}
                    className={
                      playing === key ? 'plan-ticket--playing' : undefined
                    }
                    data-section={key}
                  >
                    <div>
                      <strong>{ticket.name ?? ticket.title}</strong>
                      {ticket.lane !== undefined && (
                        <LaneTag lane={ticket.lane} was={ticket.laneWas} />
                      )}
                      {ticket.today !== undefined &&
                      ticket.after !== undefined ? (
                        <dl className="today-after">
                          <dt>Today</dt>
                          <dd>{ticket.today}</dd>
                          <dt>After</dt>
                          <dd>{ticket.after}</dd>
                        </dl>
                      ) : (
                        <p className="muted">{ticket.summary}</p>
                      )}
                    </div>
                    <button
                      className="icon"
                      type="button"
                      title="Play from this ticket"
                      onClick={() => onPlaySection(key)}
                    >
                      <SpeakerIcon />
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

      {question.context !== undefined && (
        <Section
          sectionKey="context"
          label="Context"
          playing={playing}
          onPlay={onPlaySection}
        >
          <Markdown text={question.context} />
        </Section>
      )}

      {question.problem !== undefined && !isCheckpoint && (
        <Section
          sectionKey="problem"
          label="Problem"
          playing={playing}
          onPlay={onPlaySection}
        >
          <Markdown text={question.problem} />
        </Section>
      )}

      {question.options.length > 0 && (
        <Section
          sectionKey="options"
          label="Options"
          playing={playing}
          onPlay={onPlaySection}
        >
          <ol className="options">
            {question.options.map((option) => (
              <li
                key={option.id}
                className={`option${
                  pickedOption === option.id ? ' option--picked' : ''
                }${onPickOption === undefined ? '' : ' option--pickable'}`}
                {...(onPickOption === undefined
                  ? {}
                  : {
                      role: 'button',
                      tabIndex: 0,
                      'aria-pressed': pickedOption === option.id,
                      onClick: () => onPickOption(option.id),
                      onKeyDown: (event: KeyboardEvent<HTMLLIElement>) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onPickOption(option.id);
                        }
                      },
                    })}
              >
                <strong>
                  {option.id}) {option.label}
                </strong>
                {question.recommendation?.optionId === option.id && (
                  <span className="option__rec">Recommended</span>
                )}
                <p>{option.detail}</p>
                <p className="muted">Trade-offs: {option.tradeoffs}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {question.recommendation !== undefined && (
        <Section
          sectionKey="recommendation"
          label="Recommendation"
          playing={playing}
          onPlay={onPlaySection}
        >
          <p>
            <strong>{question.recommendation.optionId}</strong> —{' '}
            {question.recommendation.why}
          </p>
        </Section>
      )}

      {question.visual !== undefined && (
        <Section
          sectionKey="visual"
          label="UX"
          playing={playing}
          onPlay={onPlaySection}
        >
          <pre className="ascii">{question.visual.ascii}</pre>
          <p>{question.visual.notes}</p>
        </Section>
      )}

      {isCheckpoint && (
        <section className="section">
          <header>
            <h3>Decisions made for you ({productListed})</h3>
          </header>
          {productOnScreens > 0 && (
            <p className="muted">
              {productOnScreens === 1
                ? '1 more is'
                : `${productOnScreens} more are`}{' '}
              under the screens that show{' '}
              {productOnScreens === 1 ? 'it' : 'them'}.
            </p>
          )}
          {reviewed.length === 0 && <p className="muted">None this phase.</p>}
          {[false, true].map((engineeringGroup) => {
            // Product calls first; engineering calls in their own collapsed
            // group (their 🔊 plays on demand — not part of the item's audio).
            const group = reviewed
              .map((decision, index) => ({ decision, index }))
              .filter(
                ({ decision }) =>
                  (decision.kind === 'engineering') === engineeringGroup &&
                  !onScreens.has(decision.id)
              );

            if (group.length === 0) {
              return null;
            }

            const list = (
              <ol className="decisions">
                {group.map(({ decision, index }) => {
                  const key = `decision-${index + 1}`;
                  const spokenOnDemand = engineeringGroup;
                  const open = expanded.has(decision.id);
                  // Newer decisions read like the tickets: Means / Why / Instead,
                  // always visible. Older ones keep the headline + why shape.
                  const structured = decision.means !== undefined;
                  const hasDetails =
                    decision.details !== undefined ||
                    (!structured && decision.instead !== undefined);

                  return (
                    <li
                      key={decision.id}
                      data-section={key}
                      data-card={decisionCardKey(decision.id)}
                      className={`decision${
                        playing === key ? ' decision--playing' : ''
                      }${hasDetails ? ' decision--expandable' : ''}${
                        changedHere(decisionCardKey(decision.id))
                          ? ' card--changed-here'
                          : ''
                      }`}
                    >
                      <span className="decision__number">{index + 1}</span>
                      <div className="decision__body">
                        <div className="decision__mark">
                          {markOf(
                            decisionCardKey(decision.id),
                            `Decision ${index + 1}`
                          )}
                        </div>
                        <button
                          type="button"
                          className="decision__headline"
                          disabled={!hasDetails}
                          aria-expanded={hasDetails ? open : undefined}
                          onClick={() => toggle(decision.id)}
                        >
                          {hasDetails && (
                            <span className="decision__chevron">
                              {open ? '▾' : '▸'}
                            </span>
                          )}
                          {decision.ux === true && (
                            <span className="kind kind--small">UX</span>
                          )}
                          {decision.decision}
                          {decision.tickets !== undefined &&
                            decision.tickets.length > 0 && (
                              <span className="decision__tickets">
                                {decision.tickets.length === 1
                                  ? 'Ticket'
                                  : 'Tickets'}{' '}
                                {decision.tickets.join(', ')}
                              </span>
                            )}
                          {/* Inside the button: clicking the justification toggles too. */}
                          {!structured && (
                            <span className="decision__why muted">
                              {decision.why}
                            </span>
                          )}
                        </button>
                        {structured && (
                          <dl className="today-after decision__parts">
                            {decision.before !== undefined && (
                              <>
                                <dt>Before</dt>
                                <dd>{decision.before}</dd>
                              </>
                            )}
                            <dt>
                              {decision.before === undefined
                                ? 'Means'
                                : 'After'}
                            </dt>
                            <dd>{decision.means}</dd>
                            <dt>Why</dt>
                            <dd>{decision.why}</dd>
                            {decision.instead !== undefined && (
                              <>
                                <dt>Instead</dt>
                                <dd className="muted">{decision.instead}</dd>
                              </>
                            )}
                          </dl>
                        )}
                        {open &&
                          !structured &&
                          decision.instead !== undefined && (
                            <p className="decision__instead">
                              <strong>Instead of:</strong> {decision.instead}
                            </p>
                          )}
                        {open && decision.details !== undefined && (
                          <pre className="decision__details">
                            {decision.details}
                          </pre>
                        )}
                      </div>
                      <button
                        type="button"
                        className="icon"
                        title={
                          spokenOnDemand
                            ? 'Play this engineering decision (on demand)'
                            : `Play decision ${index + 1}`
                        }
                        onClick={() =>
                          spokenOnDemand
                            ? onPlayExtra(
                                key,
                                engineeringDecisionSpeech({
                                  number: index + 1,
                                  headline: decision.decision,
                                  why: decision.why,
                                  before: decision.before,
                                  means: decision.means,
                                  instead: decision.instead,
                                })
                              )
                            : onPlaySection(key)
                        }
                      >
                        {spokenOnDemand && extra?.key === key ? (
                          extra.loading ? (
                            '…'
                          ) : (
                            '■'
                          )
                        ) : (
                          <SpeakerIcon />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ol>
            );

            return engineeringGroup ? (
              <details key="engineering" className="decisions__engineering">
                <summary>
                  Engineering decisions ({group.length}) — only the build
                  notices these
                </summary>
                {list}
              </details>
            ) : (
              <Fragment key="product">{list}</Fragment>
            );
          })}
        </section>
      )}

      {isCheckpoint &&
        question.checkpoint?.suggestedJudgements !== undefined &&
        question.checkpoint.suggestedJudgements.length > 0 && (
          <SuggestedJudgements
            judgements={question.checkpoint.suggestedJudgements}
            kept={question.checkpoint.keptJudgements ?? []}
            playing={playing}
            onPlay={onPlaySection}
            onKeep={onKeepJudgements}
          />
        )}

      {isCheckpoint && (
        <Section
          sectionKey="instructions"
          label="How to respond"
          playing={playing}
          onPlay={onPlaySection}
        >
          {/* Approving is the footer's button (⌘⏎) — one place, not two. */}
          <p className="muted">
            Type or say a decision’s number with what you want — “2: use the
            opening date”, “explain 3”, “1: give me options”. When you’re happy,
            approve below (⌘⏎) — that approves{' '}
            {cp === undefined ? 'it' : checkpointGoal(cp, pod).approves}.
          </p>
        </Section>
      )}
    </article>
  );
};
