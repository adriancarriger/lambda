import { sameName } from './source';

/**
 * Who each computer is in a tracker, so a ticket can be assigned to it with
 * nothing typed by hand. Each computer asks its own tracker key who it
 * belongs to and reports that; Lambda keeps it against the computer's id
 * (never its name), and hands every computer the map of names to tracker
 * users, built afresh from the current names: a renamed computer keeps its
 * tickets. `tickets.assignees` in lambda.json still wins, for a person who
 * isn't a Lambda account or a key shared between computers. Pure, but for
 * the types the runner and the mothership both use.
 */

export const TRACKERS = ['linear', 'jira'] as const;

export type Tracker = (typeof TRACKERS)[number];

/** One computer's user in one tracker: `who` is what a source looks it up by. */
export interface TrackerIdentity {
  tracker: Tracker;
  /** Its email where the tracker gives one, else its name. */
  who: string;
  /** Its name, for Settings → Computers ("Linear: Leslie Knope"). */
  name: string | null;
}

/** A computer as the map is built from: its id, current name and identities. */
export interface ComputerIdentities {
  runnerId: string;
  name: string;
  identities: TrackerIdentity[];
}

/**
 * What every computer is handed: per tracker, each computer's current name
 * (and the owner's) → its tracker user; and each computer's name by id, so
 * a markdown ticket assigned by id follows a rename.
 */
export interface KnownAssignees {
  linear: Record<string, string>;
  jira: Record<string, string>;
  computers: Record<string, string>;
}

export const NO_KNOWN_ASSIGNEES: KnownAssignees = {
  linear: {},
  jira: {},
  computers: {},
};

/** A tracker user two or more computers report: either may build its tickets. */
export interface SharedTrackerUser {
  tracker: Tracker;
  who: string;
  computers: string[];
}

const isTracker = (value: unknown): value is Tracker =>
  TRACKERS.some((tracker) => tracker === value);

/** A reported identity, checked: anything else is dropped. */
export const parseIdentities = (value: unknown): TrackerIdentity[] =>
  Array.isArray(value)
    ? value.flatMap((item: unknown): TrackerIdentity[] => {
        if (typeof item !== 'object' || item === null) {
          return [];
        }

        const tracker = 'tracker' in item ? item.tracker : undefined;
        const who = 'who' in item ? item.who : undefined;
        const name = 'name' in item ? item.name : undefined;

        return isTracker(tracker) && typeof who === 'string' && who !== ''
          ? [{ tracker, who, name: typeof name === 'string' ? name : null }]
          : [];
      })
    : [];

const stringRecord = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {};

/** The map as received or read back from disk, checked. */
export const parseKnownAssignees = (value: unknown): KnownAssignees => {
  const record =
    typeof value === 'object' && value !== null ? value : undefined;

  return {
    linear: stringRecord(
      record !== undefined && 'linear' in record ? record.linear : {}
    ),
    jira: stringRecord(
      record !== undefined && 'jira' in record ? record.jira : {}
    ),
    computers: stringRecord(
      record !== undefined && 'computers' in record ? record.computers : {}
    ),
  };
};

/**
 * The map every computer is handed. The owner is matched by the email they
 * signed in with (their tracker login's: `lambda init --email`), named as
 * Lambda names them, so "Yours, by hand" is theirs in the tracker too. A
 * computer whose name is the owner's keeps the owner's entry.
 */
export const buildKnownAssignees = (
  computers: ComputerIdentities[],
  owner: { name: string; email: string | null }
): KnownAssignees => {
  const forTracker = (tracker: Tracker): Record<string, string> => {
    const entries = computers.flatMap((computer) =>
      computer.identities
        .filter((identity) => identity.tracker === tracker)
        .map((identity): [string, string] => [computer.name, identity.who])
    );
    const ownerEntry: Array<[string, string]> =
      owner.email === null ||
      owner.name === '' ||
      entries.some(([name]) => sameName(name, owner.name))
        ? []
        : [[owner.name, owner.email]];

    return Object.fromEntries([...entries, ...ownerEntry]);
  };

  return {
    linear: forTracker('linear'),
    jira: forTracker('jira'),
    computers: Object.fromEntries(
      computers.map((computer) => [computer.runnerId, computer.name])
    ),
  };
};

/** Tracker users two or more computers share, for Settings' warning. */
export const sharedTrackerUsers = (
  computers: ComputerIdentities[]
): SharedTrackerUser[] =>
  TRACKERS.flatMap((tracker) => {
    const byUser = new Map<string, string[]>();
    computers.forEach((computer) =>
      computer.identities
        .filter((identity) => identity.tracker === tracker)
        .forEach((identity) => {
          const key = identity.who.toLowerCase();
          byUser.set(key, [...(byUser.get(key) ?? []), computer.name]);
        })
    );

    return [...byUser]
      .filter(([, names]) => names.length > 1)
      .map(([who, names]) => ({ tracker, who, computers: names }));
  });

/**
 * What a source on this computer uses: lambda.json's entries first (they
 * win), then this computer's own (so a tracker user it shares with another
 * computer reads as this one's, and its queue takes those tickets), then
 * the rest. A name lambda.json maps is never mapped again.
 */
export const mergeAssignees = (
  overrides: Record<string, string> | undefined,
  known: Record<string, string>,
  own: string | null
): Record<string, string> => {
  const set = overrides ?? {};
  const fresh = Object.entries(known).filter(
    ([name]) => !Object.keys(set).some((typed) => sameName(typed, name))
  );
  const mine = fresh.filter(([name]) => own !== null && sameName(name, own));
  const others = fresh.filter(([name]) => own === null || !sameName(name, own));

  return Object.fromEntries([...Object.entries(set), ...mine, ...others]);
};
