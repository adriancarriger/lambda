import type { ProposedTicket, Question, Screen } from '../../pod-store';

/**
 * A checkpoint's versions as one timeline, and every card in it (its screens,
 * its proposed tickets, its decisions) tracked against that timeline: which
 * versions added, changed or removed it.
 *
 * Screens and tickets are known by their title — renumbering isn't a change,
 * a renamed card starts again. Decisions are known by their id, and their
 * wording comes from the copy each version keeps (`decisionSnapshot`).
 */

export const screenCardKey = (screen: Screen): string =>
  `screen:${screen.name.trim()}`;

export const ticketCardKey = (ticket: ProposedTicket): string =>
  `ticket:${ticket.title.trim()}`;

export const decisionCardKey = (decisionId: string): string =>
  `decision:${decisionId}`;

export type CardChange = 'added' | 'changed' | 'removed';

export interface VersionMeta {
  version: number;
  at: string;
  kind: 'posted' | 'reposted' | 'edited';
  /** How many cards it added, changed or removed. */
  changes: number;
}

export interface Timeline {
  /** Oldest first; the last is the current one. */
  versions: VersionMeta[];
  /** Card key → the versions that touched it. */
  cards: Map<string, Map<number, CardChange>>;
}

/** Every card in one version of a checkpoint: key → what it says. */
const cardsOf = (question: Question): Map<string, string> =>
  new Map<string, string>([
    ...(question.checkpoint?.screens ?? []).map((screen): [string, string] => [
      screenCardKey(screen),
      JSON.stringify(screen),
    ]),
    ...(question.checkpoint?.proposal ?? []).map((ticket): [string, string] => [
      ticketCardKey(ticket),
      JSON.stringify(ticket),
    ]),
    ...(question.checkpoint?.decisionSnapshot ?? []).map(
      (decision): [string, string] => [
        decisionCardKey(decision.id),
        JSON.stringify([
          decision.decision,
          decision.before,
          decision.means,
          decision.kind,
          decision.why,
          decision.tickets,
          decision.details,
          decision.ux,
          decision.instead,
        ]),
      ]
    ),
  ]);

const changeBetween = (
  before: string | undefined,
  after: string | undefined
): CardChange | null => {
  if (before === after) {
    return null;
  }

  if (before === undefined) {
    return 'added';
  }

  return after === undefined ? 'removed' : 'changed';
};

/** The timeline of a checkpoint's versions (oldest first, current last). */
export const buildTimeline = (history: Question[]): Timeline => {
  const cards = new Map<string, Map<number, CardChange>>();
  const contents = history.map(cardsOf);
  const versions = history.map((checkpoint, index): VersionMeta => {
    const version = checkpoint.checkpoint?.version ?? 1;
    const now = contents[index] ?? new Map<string, string>();
    const before = contents[index - 1] ?? new Map<string, string>();
    const touched = [...new Set([...before.keys(), ...now.keys()])].flatMap(
      (key) => {
        const change = changeBetween(before.get(key), now.get(key));

        return change === null ? [] : [{ key, change }];
      }
    );
    touched.forEach(({ key, change }) => {
      cards.set(key, new Map([...(cards.get(key) ?? []), [version, change]]));
    });

    return {
      version,
      at: checkpoint.checkpoint?.versionAt ?? checkpoint.createdAt,
      kind: checkpoint.checkpoint?.versionKind ?? 'posted',
      // v1 adds everything: that's the post, not a list of changes.
      changes: index === 0 ? 0 : touched.length,
    };
  });

  return { versions, cards };
};

/**
 * What to say about a card while version `upTo` is on screen: its latest
 * change at or before it ("added v3", "changed v8"). Undefined: not in it.
 */
export const lastChange = (
  timeline: Timeline,
  key: string,
  upTo: number
): { version: number; change: 'added' | 'changed' } | undefined => {
  const [latest] = [...(timeline.cards.get(key) ?? [])]
    .filter(([version]) => version <= upTo)
    .sort(([a], [b]) => b - a);

  if (latest === undefined || latest[1] === 'removed') {
    return undefined;
  }

  return { version: latest[0], change: latest[1] };
};
