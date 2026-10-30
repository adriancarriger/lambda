import { type StripStep, phaseStrip } from '../shared/lambdaPage';

/**
 * Planning → Ready → Building → (QA) → Merged, under a Lambda's header in
 * every phase: done steps filled, this one black, the rest waiting.
 */
export const PhaseStrip = ({
  at,
  qaOn,
}: {
  at: StripStep;
  /** The project's review step is on. */
  qaOn: boolean;
}) => (
  <nav className="phase-strip" aria-label="Phases">
    {phaseStrip(at, qaOn).map((step, index) => (
      <span key={step.id} className="phase-strip__item">
        {index > 0 && (
          <span
            className={`phase-strip__line${
              step.state === 'todo' ? '' : ' phase-strip__line--done'
            }`}
            aria-hidden="true"
          />
        )}
        <span
          className={`phase-strip__step phase-strip__step--${step.state}`}
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <span className="phase-strip__dot" aria-hidden="true" />
          {step.label}
        </span>
      </span>
    ))}
  </nav>
);
