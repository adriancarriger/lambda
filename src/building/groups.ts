import * as fs from 'fs';
import * as path from 'path';

import {
  type GroupEvent,
  type ShippingGroups,
  shippingGroups,
} from '../app/shared/shippingGroups';
import { EVENTS_FILE } from '../events/watcher';
import { type TicketSource, isUnknownTicket } from '../tickets/source';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** One events.jsonl line as a group event; null when it isn't one. */
const groupEventOf = (text: string, line: number): GroupEvent | null => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON: no group event (the runner reports the bad line itself).
      return null;
    }
  })();

  if (
    !isRecord(parsed) ||
    typeof parsed.type !== 'string' ||
    !parsed.type.startsWith('group.')
  ) {
    return null;
  }

  return {
    type: parsed.type,
    groupId: str(parsed.groupId),
    ticket: str(parsed.ticket),
    reason: str(parsed.reason),
    held: typeof parsed.held === 'boolean' ? parsed.held : null,
    at: str(parsed.at) ?? 0,
    line,
  };
};

/**
 * The project's shipping-together groups as it reports them: the `group.*`
 * lines of `<project>/.lambda/events.jsonl`, with their line numbers.
 */
export const projectGroups = (projectRoot: string): ShippingGroups => {
  const file = path.join(projectRoot, EVENTS_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  return shippingGroups(
    text
      .split('\n')
      .map((line, index) => groupEventOf(line, index + 1))
      .filter((event): event is GroupEvent => event !== null)
  );
};

/** Tickets `lambda ship` shipped: a passing `ship.end` in events.jsonl. */
const shippedByLambda = (projectRoot: string): Set<string> => {
  const file = path.join(projectRoot, EVENTS_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  return new Set(
    text.split('\n').flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);

        return isRecord(parsed) &&
          parsed.type === 'ship.end' &&
          parsed.result === 'pass' &&
          typeof parsed.ticket === 'string'
          ? [parsed.ticket]
          : [];
      } catch {
        return [];
      }
    })
  );
};

/**
 * The runner asks every few seconds: per project, the events file as last
 * read (unchanged, nothing to do) and the tickets already known done, so the
 * tracker is asked about each one once rather than on every tick.
 */
const seen = new Map<string, { stamp: string | null; done: Set<string> }>();

const stampOf = (projectRoot: string): string => {
  const file = path.join(projectRoot, EVENTS_FILE);

  if (!fs.existsSync(file)) {
    return 'none';
  }

  const stat = fs.statSync(file);

  return `${stat.mtimeMs}:${stat.size}`;
};

/**
 * A ticket that shipped inside a shipping-together group is done once the
 * project says the group shipped (`group.shipped`), whoever shipped it: a
 * building pod, or a person with `lambda ship`. One that never shipped stays
 * as it is. Each ticket on its own: one the tracker no longer has is settled
 * (there is nothing to mark), one it refuses for now is logged and tried on
 * the next tick, and the others still go. Answers the tickets it marked done.
 */
export const markShippedGroupsDone = async (
  projectRoot: string,
  source: Pick<TicketSource, 'get' | 'update'>,
  deps: { log: (line: string) => void }
): Promise<string[]> => {
  const stamp = stampOf(projectRoot);
  const known = seen.get(projectRoot);

  if (known?.stamp === stamp) {
    return [];
  }

  const confirmed = known?.done ?? new Set<string>();
  const shipped = shippedByLambda(projectRoot);
  const due = projectGroups(projectRoot).shippedTickets.filter(
    (id) => shipped.has(id) && !confirmed.has(id)
  );

  const outcome = await due.reduce<
    Promise<{ marked: string[]; failed: boolean }>
  >(async (done, ticketId) => {
    const sofar = await done;

    try {
      const ticket = await source.get(ticketId);

      if (ticket.status !== 'done') {
        await source.update(ticketId, { status: 'done' });
      }

      confirmed.add(ticketId);

      return ticket.status === 'done'
        ? sofar
        : { ...sofar, marked: [...sofar.marked, ticketId] };
    } catch (error) {
      if (isUnknownTicket(error, ticketId)) {
        confirmed.add(ticketId);
        deps.log(
          `${ticketId} is no longer in the tracker: it can't be marked done.`
        );

        return sofar;
      }

      deps.log(
        `Couldn't mark ${ticketId} done (trying again): ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      return { ...sofar, failed: true };
    }
  }, Promise.resolve({ marked: [], failed: false }));
  // The file counts as read only once every one went through: a failure is
  // tried on the next tick even when nothing new was reported.
  seen.set(projectRoot, {
    stamp: outcome.failed ? null : stamp,
    done: confirmed,
  });

  return outcome.marked;
};
