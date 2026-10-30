import { blockerChoices } from '../shared/lambdaPage';

/**
 * A build blocked on the owner, answered in place: its question, its
 * options as choices (the recommended one picked), Answer and carry on, and
 * Plan more. The same card on a Lambda's page and its ticket's page. Its
 * state is the page's: the player bar's main action answers it too.
 */

export interface Blocker {
  what: string;
  problem: string;
  options: string;
  recommendation: string;
}

/** The answer a card holds: the choice picked, else the words typed. */
export const blockerAnswer = (
  blocker: Blocker | undefined,
  choice: number | null,
  words: string
): string => {
  const { choices, recommended } =
    blocker === undefined
      ? { choices: [], recommended: -1 }
      : blockerChoices(blocker.options, blocker.recommendation);

  return choices.length > 0
    ? choices[choice ?? recommended] ?? ''
    : words.trim();
};

export const BlockerCard = ({
  blocker,
  computer,
  fallback,
  choice,
  words,
  busy,
  onChoice,
  onWords,
  onAnswer,
  onPlanMore,
}: {
  /** The blocked run's question; undefined while it loads. */
  blocker: Blocker | undefined;
  computer: string | null;
  /** Shown while the blocked run is unknown (an older computer). */
  fallback?: React.ReactNode;
  choice: number | null;
  words: string;
  busy: boolean;
  onChoice: (index: number) => void;
  onWords: (text: string) => void;
  onAnswer: () => void;
  onPlanMore: () => void;
}) => {
  const { choices, recommended } =
    blocker === undefined
      ? { choices: [], recommended: -1 }
      : blockerChoices(blocker.options, blocker.recommendation);
  const chosen = choice ?? recommended;
  const waiting =
    computer === null
      ? 'The build is waiting on this.'
      : `${computer} is waiting on this.`;

  return (
    <article className="lambda-card lambda-card--blocked">
      <div className="lambda-card__top">
        <span className="lambda-card__badge">Blocked</span>
        <strong>
          {blocker?.problem ??
            (computer === null
              ? 'The build is waiting on you'
              : `${computer} is waiting on you`)}
        </strong>
      </div>
      {blocker !== undefined ? (
        <p className="lambda-card__body">
          {blocker.what}. {waiting}
        </p>
      ) : (
        fallback
      )}
      {choices.length > 0 ? (
        <div
          className="lambda-card__choices"
          role="radiogroup"
          aria-label="Your answer"
        >
          {choices.map((one, index) => (
            <label key={one} className="lambda-card__choice">
              <input
                type="radio"
                name="blocker"
                checked={chosen === index}
                onChange={() => onChoice(index)}
              />
              {one}
              {index === recommended && (
                <span className="lambda-card__rec">(recommended)</span>
              )}
            </label>
          ))}
        </div>
      ) : (
        <textarea
          className="lambda-card__answer"
          rows={2}
          value={words}
          placeholder="Your answer…"
          aria-label="Your answer"
          readOnly={busy}
          onChange={(event) => onWords(event.target.value)}
        />
      )}
      <div className="lambda-card__actions">
        <button
          type="button"
          className="primary"
          disabled={
            busy || (choices.length > 0 ? chosen < 0 : words.trim() === '')
          }
          onClick={onAnswer}
        >
          Answer, and carry on
        </button>
        <button
          type="button"
          className="lambda-page__button"
          onClick={onPlanMore}
        >
          Plan more
        </button>
      </div>
    </article>
  );
};
