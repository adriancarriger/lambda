/**
 * Pure decisions about computers: what the Computers screen says about each
 * one, and which runner a new pod goes to.
 */

/** A name as typed: case, and a curly apostrophe macOS puts in, don't count. */
const nameKey = (name: string): string =>
  name.trim().toLowerCase().replace(/[‘’]/g, "'");

/**
 * The computer `query` names: its id, else its name, else the one name it
 * starts ("adrian" for "Adrian’s Mac mini"). Null when none, or several.
 */
export const findComputer = <T extends { id: string; name: string }>(
  runners: T[],
  query: string
): T | null => {
  const key = nameKey(query);
  const byId = runners.find((runner) => runner.id === query.trim());
  const named = runners.filter((runner) => nameKey(runner.name) === key);
  const started = runners.filter((runner) =>
    nameKey(runner.name).startsWith(key)
  );

  if (key === '') {
    return null;
  }

  return (
    byId ??
    (named.length === 1 ? named[0] : undefined) ??
    (started.length === 1 ? started[0] : undefined) ??
    null
  );
};

/** "2 h ago": the Computers screen's last-seen time. */
export const agoText = (then: number, now: number): string => {
  const minutes = Math.floor((now - then) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} h ago`;
  }

  const days = Math.floor(hours / 24);

  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};

export interface ComputerFacts {
  connected: boolean;
  lastSeenAt: number;
  /** The project it's moving to, during an idle switch. */
  switchingTo: string | null;
  /** Any agent in its project's pods mid-turn. */
  midTurn: boolean;
}

/**
 * `offline · last seen <time>` when its socket is closed; `switching to
 * <project>…` during an idle switch; `running` when an agent is mid-turn;
 * otherwise `idle`.
 */
export const computerState = (facts: ComputerFacts, now: number): string => {
  if (!facts.connected) {
    return `offline · last seen ${agoText(facts.lastSeenAt, now)}`;
  }

  if (facts.switchingTo !== null) {
    return `switching to ${facts.switchingTo}…`;
  }

  return facts.midTurn ? 'running' : 'idle';
};

/** A turn is mid-way when it started after it last ended (watchdog.ts). */
export const isMidTurn = (turn: {
  startedAt?: string;
  endedAt?: string;
}): boolean =>
  turn.startedAt !== undefined &&
  (turn.endedAt === undefined || turn.startedAt > turn.endedAt);

export interface Holder {
  runnerId: string;
  name: string;
  connected: boolean;
  currentProjectId: string | null;
  lastSeenAt: number;
  /** Mid idle switch: on neither project until it reports where it landed. */
  switching: boolean;
}

export type Placement =
  /** Send it now: this runner is already on the project. */
  | { kind: 'send'; runnerId: string }
  /** Keep it waiting until a connected holder goes idle and switches. */
  | { kind: 'wait' }
  /** Every holder is offline: refuse, naming the most recently seen. */
  | { kind: 'offline'; name: string }
  /** No computer holds the project at all. */
  | { kind: 'none' };

export const placePod = (projectId: string, holders: Holder[]): Placement => {
  const connected = holders.filter((holder) => holder.connected);
  // A runner mid-switch is tearing its old project down: sending there would
  // start the pod inside the stop. It waits, and the switch's runner (or the
  // next idle one) starts it.
  const onProject = connected.find(
    (holder) => !holder.switching && holder.currentProjectId === projectId
  );

  if (onProject !== undefined) {
    return { kind: 'send', runnerId: onProject.runnerId };
  }

  if (connected.length > 0) {
    return { kind: 'wait' };
  }

  const [latest] = [...holders].sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return latest === undefined
    ? { kind: 'none' }
    : { kind: 'offline', name: latest.name };
};
