/**
 * The ship gate: `lambda ship` refuses a ticket whose acceptance criteria
 * were never checked, or were checked and found unmet. Shipping can't judge
 * the criteria itself (that's the check-ticket step), so it asks the
 * narrower question it can answer: is a COMPLETE verdict recorded? A ticket
 * with a design is also asked for its visual check's record: MATCH or
 * SHIPPED_WITH_MISSES passes, missing, unreadable or BLOCKED refuses.
 *
 * **Absence refuses.** A missing verdict is the common case when the check
 * was skipped, which is exactly what the gate exists to catch. There is no
 * flag past it: close the gaps and run the check again, or block the ticket.
 */
import { type VerdictRead } from './store';
import { type VisualVerdictLookup } from './visualStore';

/** Why this ticket can't ship, as the lines to print; null when it can. */
export const describeRefusal = (
  ticket: { id: string; title: string },
  lookup: VerdictRead
): string[] | null => {
  const name = `${ticket.id} ${ticket.title}`;

  if (lookup.kind === 'missing') {
    return [
      `✗ ${name} has no COMPLETE check-ticket verdict.`,
      '  Run the check-ticket step first.',
    ];
  }

  if (lookup.kind === 'unreadable') {
    return [
      `✗ ${name}: the check-ticket verdict couldn't be read (${lookup.reason}).`,
    ];
  }

  if (lookup.verdict.verdict === 'COMPLETE') {
    return null;
  }

  const failed = lookup.verdict.failedDimensions;

  return [
    `✗ ${name}'s last check-ticket verdict was INCOMPLETE.`,
    ...(failed.length > 0 ? [`  Failed: ${failed.join(', ')}`] : []),
  ];
};

/**
 * Whether a description carries its design: the exact `## Design` heading.
 * `## Design reference (checked when ticket <N> is built)` is an earlier
 * ticket's copy of a later ticket's pictures, and never matches.
 */
export const hasDesignSection = (description: string): boolean =>
  /^## Design\s*$/m.test(description);

/** The `## Design` section's text, up to the next `#` or `##` heading. */
export const designSection = (description: string): string | null => {
  const lines = description.split('\n');
  const start = lines.findIndex((line) => /^## Design\s*$/.test(line));

  if (start === -1) {
    return null;
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,2}\s/.test(line)
  );

  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
};

/**
 * Whether the visual check has anything to photograph: a `## Design` with at
 * least one case-sensitive `Scenario: <id>` line. Planning leaves those lines
 * out when the project had no photo hook then, and such a ticket's step is
 * skipped ("no scenario"), so the gate doesn't ask for its record either.
 */
export const hasDesignScenarios = (description: string): boolean =>
  /^Scenario: \S+/m.test(designSection(description) ?? '');

/**
 * Why a ticket with a design can't ship past the visual check, as the lines
 * to print; null when its record is MATCH or SHIPPED_WITH_MISSES. Missing and
 * unreadable are kept apart, as for the check-ticket verdict.
 */
export const describeVisualRefusal = (
  ticket: { id: string; title: string },
  lookup: VisualVerdictLookup
): string[] | null => {
  const name = `${ticket.id} ${ticket.title}`;

  if (lookup.state === 'missing') {
    return [
      `✗ ${name} has a design but no visual check.`,
      '  Run the visual-check step first.',
    ];
  }

  if (lookup.state === 'unreadable') {
    return [
      `✗ ${name}: the visual check record couldn't be read (${lookup.reason}).`,
    ];
  }

  return lookup.verdict.result === 'BLOCKED'
    ? [`✗ ${name}'s visual check is blocked.`]
    : null;
};

/**
 * Whether `lambda ship` asks this ticket for a visual record: the step is on,
 * the project has a photo hook, and the description has a `## Design` with a
 * scenario to photograph. Anything else passes.
 */
export const needsVisualRecord = (input: {
  stepOn: boolean;
  hasPhotoHook: boolean;
  description: string;
}): boolean =>
  input.stepOn &&
  input.hasPhotoHook &&
  hasDesignSection(input.description) &&
  hasDesignScenarios(input.description);
