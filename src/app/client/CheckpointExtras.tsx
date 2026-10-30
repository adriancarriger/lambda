import type { ReactNode } from 'react';

import type {
  Change,
  ProposedTicket,
  SuggestedJudgement,
} from '../../pod-store';
import { ticketCardKey } from '../shared/cardHistory';
import {
  type SectionKey,
  changeSectionKey,
  judgementSectionKey,
  proposalCounts,
  proposalSectionKey,
} from '../shared/speech';
import { LaneTag } from './LaneTag';
import { SpeakerIcon } from './SpeakerIcon';

/**
 * The pipeline-2 parts of a checkpoint card: the split proposal (CP3), "What I
 * understood" (CP4) and the change lists (CP4: since the split was approved;
 * CP5: since the UX review). Spoken by shared/speech.ts's checkpointSections.
 */

const PlayButton = ({
  title,
  onClick,
}: {
  title: string;
  onClick: () => void;
}) => (
  <button className="icon" type="button" title={title} onClick={onClick}>
    <SpeakerIcon />
  </button>
);

export const Understood = ({
  text,
  playing,
  onPlay,
}: {
  text: string;
  playing: SectionKey | null;
  onPlay: (key: SectionKey) => void;
}) => (
  <section
    className={`section${playing === 'understood' ? ' section--playing' : ''}`}
    data-section="understood"
  >
    <header>
      <h3>What I understood</h3>
      <PlayButton title="Play" onClick={() => onPlay('understood')} />
    </header>
    <p>{text}</p>
  </section>
);

const CHANGE_LABEL: Record<Change['kind'], string> = {
  screen: 'Screen',
  ticket: 'Ticket',
  e2e: 'E2E',
  human: 'Needs you',
  engineering: 'Engineering',
};

export const Changes = ({
  changes,
  since,
  playing,
  onPlay,
}: {
  changes: Change[];
  since: string;
  playing: SectionKey | null;
  onPlay: (key: SectionKey) => void;
}) => {
  const seen = changes.filter((change) => change.kind !== 'engineering');
  const engineering = changes.filter((change) => change.kind === 'engineering');

  return (
    <section
      className={`section${playing === 'changes' ? ' section--playing' : ''}`}
      data-section="changes"
    >
      <header>
        <h3>
          Changed since {since}
          {seen.length > 0 ? ` (${seen.length})` : ''}
        </h3>
        <PlayButton
          title="Play the changes from the first"
          onClick={() =>
            onPlay(seen.length === 0 ? 'changes' : changeSectionKey(0))
          }
        />
      </header>
      {seen.length === 0 ? (
        <p className="muted">Nothing you'd see changed.</p>
      ) : (
        <ol className="changes">
          {seen.map((change, index) => {
            const key = changeSectionKey(index);

            return (
              <li
                key={change.text}
                className={playing === key ? 'plan-ticket--playing' : undefined}
                data-section={key}
              >
                <div>
                  <span className="changes__kind">
                    {CHANGE_LABEL[change.kind]}
                  </span>{' '}
                  {change.text}
                  {change.before !== undefined && (
                    <p className="changes__context">
                      <strong>Before:</strong> {change.before}
                    </p>
                  )}
                  {change.why !== undefined && (
                    <p className="changes__context">
                      <strong>Why:</strong> {change.why}
                    </p>
                  )}
                </div>
                <PlayButton
                  title="Play from this change"
                  onClick={() => onPlay(key)}
                />
              </li>
            );
          })}
        </ol>
      )}
      {engineering.length > 0 && (
        <details className="changes__engineering">
          <summary>
            {engineering.length} engineering{' '}
            {engineering.length === 1 ? 'fix' : 'fixes'} (not read aloud)
          </summary>
          <ul className="changes">
            {engineering.map((change) => (
              <li key={change.text}>{change.text}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
};

const E2E_LABEL: Record<ProposedTicket['e2e']['kind'], string> = {
  'new-file': 'New spec file',
  'new-tests': 'New tests in an existing spec',
  assertions: 'Assertions only',
  none: 'No E2E',
};

const OVERLAP_LABEL: Record<ProposedTicket['overlaps'][number]['how'], string> =
  {
    'folds-in': 'Folds in',
    overlaps: 'Overlaps',
    related: 'Related',
  };

/** CP3: the proposed split, before any ticket is written. */
export const Proposal = ({
  tickets,
  playing,
  onPlay,
  markOf,
  changedHere,
}: {
  tickets: ProposedTicket[];
  playing: SectionKey | null;
  onPlay: (key: SectionKey) => void;
  /** A ticket's "changed v8 · 2m" and its versions (CardVersions.tsx). */
  markOf: (cardKey: string, title: string) => ReactNode;
  /** The version on screen changed this ticket. */
  changedHere: (cardKey: string) => boolean;
}) => {
  const counts = proposalCounts(tickets);

  return (
    <section className="section proposal">
      <header>
        <h3>Proposed split</h3>
        <PlayButton
          title="Play the proposal from the first ticket"
          onClick={() => onPlay(proposalSectionKey(0))}
        />
      </header>
      <p className="proposal__counts">
        <strong>{tickets.length}</strong> tickets ·{' '}
        <strong>{counts['new-file']}</strong> new E2E spec{' '}
        {counts['new-file'] === 1 ? 'file' : 'files'} · {counts['new-tests']}{' '}
        add tests to an existing spec · {counts.assertions} assertions only
        {counts.none > 0 ? ` · ${counts.none} no E2E` : ''}
      </p>
      <ol className="proposal__tickets">
        {tickets.map((ticket, index) => {
          const key = proposalSectionKey(index);
          const cardKey = ticketCardKey(ticket);

          return (
            <li
              key={ticket.number}
              className={`${playing === key ? 'plan-ticket--playing' : ''}${
                changedHere(cardKey) ? ' card--changed-here' : ''
              }`}
              data-section={key}
              data-card={cardKey}
            >
              <div>
                <div className="proposal__title">
                  <strong>
                    {ticket.number} - {ticket.title}
                  </strong>
                  {ticket.lane !== undefined && <LaneTag lane={ticket.lane} />}
                  {markOf(cardKey, `${ticket.number} - ${ticket.title}`)}
                </div>
                <p>{ticket.what}</p>
                <p
                  className={`proposal__e2e proposal__e2e--${ticket.e2e.kind}`}
                >
                  <span>{E2E_LABEL[ticket.e2e.kind]}</span>
                  {ticket.e2e.spec !== undefined && (
                    <code>{ticket.e2e.spec}</code>
                  )}
                  {ticket.e2e.why !== undefined && (
                    <span className="muted"> — {ticket.e2e.why}</span>
                  )}
                </p>
                {ticket.dependsOn.length > 0 && (
                  <p className="muted">After {ticket.dependsOn.join(', ')}</p>
                )}
                {ticket.docs.length > 0 && (
                  <p className="muted">
                    Docs to update: {ticket.docs.join(', ')}
                  </p>
                )}
                {ticket.overlaps.map((overlap) => (
                  <p key={overlap.id} className="muted">
                    {OVERLAP_LABEL[overlap.how]} {overlap.id}: {overlap.note}
                  </p>
                ))}
                <details className="proposal__files">
                  <summary>Where in the code ({ticket.files.length})</summary>
                  <ul>
                    {ticket.files.map((file) => (
                      <li key={file}>
                        <code>{file}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
              <PlayButton
                title="Play from this ticket"
                onClick={() => onPlay(key)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
};

/**
 * CP5: lasting judgements suggested from what they decided in this pod. Ticks
 * are saved on the checkpoint as they make them; the ticked ones go into the
 * knowledge store when they close it.
 */
export const SuggestedJudgements = ({
  judgements,
  kept,
  playing,
  onPlay,
  onKeep,
}: {
  judgements: SuggestedJudgement[];
  kept: number[];
  playing: SectionKey | null;
  onPlay: (key: SectionKey) => void;
  onKeep: (indices: number[]) => void;
}) => {
  const all = judgements.map((_judgement, index) => index);
  const everything = kept.length === judgements.length;
  const toggle = (index: number): void =>
    onKeep(
      kept.includes(index)
        ? kept.filter((other) => other !== index)
        : [...kept, index].sort((a, b) => a - b)
    );

  return (
    <section className="section judgements">
      <header>
        <h3>Suggested judgements ({judgements.length})</h3>
        <PlayButton
          title="Play the suggestions from the first"
          onClick={() => onPlay(judgementSectionKey(0))}
        />
      </header>
      <p className="muted">
        Lasting rules for future tickets, from what you decided here. Ticked
        ones are kept when you close the checkpoint.
      </p>
      <label className="judgements__all">
        <input
          type="checkbox"
          checked={everything}
          onChange={() => onKeep(everything ? [] : all)}
        />{' '}
        Select all
      </label>
      <ol className="judgements__list">
        {judgements.map((judgement, index) => {
          const key = judgementSectionKey(index);

          return (
            <li
              key={judgement.statement}
              className={playing === key ? 'plan-ticket--playing' : undefined}
              data-section={key}
            >
              <label className="judgements__item">
                <input
                  type="checkbox"
                  checked={kept.includes(index)}
                  onChange={() => toggle(index)}
                />
                <div>
                  <strong>
                    {judgement.kind === 'copy' ? 'Wording · ' : ''}
                    {judgement.statement}
                  </strong>
                  <p>
                    <span className="judgements__label">
                      Why it's good long term:
                    </span>{' '}
                    {judgement.why}
                  </p>
                  {judgement.copy !== undefined && (
                    <p className="muted">
                      Say “{judgement.copy.use}”
                      {judgement.copy.never.length === 0
                        ? ''
                        : `, never ${judgement.copy.never
                            .map((term) => `“${term}”`)
                            .join(', ')}`}
                      .
                    </p>
                  )}
                  <p className="muted">Your words: “{judgement.quote}”</p>
                </div>
              </label>
              <PlayButton
                title="Play this suggestion"
                onClick={() => onPlay(key)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
};
