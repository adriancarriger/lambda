import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type PodStore, createPodStore } from '../../pod-store';
import type {
  Reporter,
  Ticket,
  TicketSource,
  TicketState,
  TicketWithDescription,
  UpdateInput,
} from '../../tickets/source';
import { findNext, unknownTicket } from '../../tickets/source';
import { type OwnerIdentity, isOwnersReporter } from '../owner';

/**
 * Fakes for the building suites: tickets in memory, and the mothership's
 * claim table (one row per ticket, the insert is the claim, the owner is
 * checked as the backstop) shared by every runner that asks it.
 */

export const LESLIE: OwnerIdentity = {
  name: 'Leslie Knope',
  email: 'leslie@pawnee.gov',
  aliases: [],
};

export const ticket = (
  id: string,
  extra: Partial<Ticket> = {}
): TicketWithDescription => ({
  id,
  title: `Ticket ${id}`,
  status: 'ready',
  labels: [],
  parent: null,
  children: [],
  blockedBy: [],
  blockReason: null,
  reporter: null,
  url: null,
  priority: 'none',
  assignee: null,
  description: `What ticket ${id} does.`,
  ...extra,
});

export interface FakeSource extends TicketSource {
  tickets: TicketWithDescription[];
  updates: { id: string; input: UpdateInput }[];
  statusOf: (id: string) => TicketState | undefined;
  /** The next update of this ticket fails, as a tracker's API error would. */
  failNextUpdate: (id: string) => void;
}

const unused = (name: string) => () => {
  throw new Error(`The fake ticket source has no ${name}.`);
};

export const fakeSource = (
  tickets: TicketWithDescription[],
  /** Blockers the tracker keeps out of its list (Linear's archived ones). */
  outside: ReadonlyMap<string, TicketState> = new Map()
): FakeSource => {
  const state: {
    tickets: TicketWithDescription[];
    updates: { id: string; input: UpdateInput }[];
    failing: Set<string>;
  } = {
    tickets: tickets.map((one) => ({ ...one })),
    updates: [],
    failing: new Set(),
  };
  const find = (id: string): TicketWithDescription => {
    const found = state.tickets.find((one) => one.id === id);

    if (found === undefined) {
      throw unknownTicket(id);
    }

    return found;
  };

  return {
    kind: 'markdown',
    projects: async () => [],
    get tickets() {
      return state.tickets;
    },
    get updates() {
      return state.updates;
    },
    statusOf: (id) => state.tickets.find((one) => one.id === id)?.status,
    failNextUpdate: (id) => {
      state.failing.add(id);
    },
    list: async () => state.tickets.map((one) => ({ ...one })),
    get: async (id) => ({ ...find(id) }),
    update: async (id, input) => {
      const current = find(id);

      if (state.failing.delete(id)) {
        throw new Error('Linear answered 500: Internal server error');
      }

      state.updates = [...state.updates, { id, input }];
      const next = {
        ...current,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.status === 'blocked'
          ? { blockReason: input.reason ?? null }
          : {}),
      };
      state.tickets = state.tickets.map((one) => (one.id === id ? next : one));

      return { ...next };
    },
    next: async () => findNext(state.tickets, {}, outside),
    queue: async () => ({
      tickets: state.tickets.map((one) => ({ ...one })),
      outside,
    }),
    attach: unused('attach'),
    pull: unused('pull'),
    push: unused('push'),
    create: unused('create'),
    comment: async () => undefined,
    comments: async () => [],
    delete: unused('delete'),
    block: unused('block'),
    unblock: unused('unblock'),
    reorder: unused('reorder'),
    place: unused('place'),
  };
};

export interface ClaimRow {
  ticketId: string;
  runnerId: string;
  shippedAt: number | null;
}

/** The mothership's `ticket_claims`, and the four messages that touch it. */
export const fakeMothership = (owner: OwnerIdentity = LESLIE) => {
  const rows = new Map<string, ClaimRow>();
  const state = { reachable: true, asked: 0 };
  const reach = (): void => {
    state.asked += 1;

    if (!state.reachable) {
      throw new Error("Couldn't reach Lambda.");
    }
  };

  const forRunner = (runnerId: string) => ({
    claims: async (): Promise<ClaimRow[]> => {
      reach();

      return [...rows.values()].map((row) => ({ ...row }));
    },
    claim: async (ticketId: string, reporter: Reporter | null) => {
      reach();
      // Yield, so two runners asking at once really interleave.
      await new Promise((resolve) => setImmediate(resolve));

      if (!isOwnersReporter(reporter, owner)) {
        return 'not-owner' as const;
      }

      const row = rows.get(ticketId);

      // A runner asking again for its own claim gets it back (a pick-up
      // whose status update failed tries again).
      if (row !== undefined) {
        return row.runnerId === runnerId && row.shippedAt === null
          ? ('claimed' as const)
          : ('taken' as const);
      }

      rows.set(ticketId, { ticketId, runnerId, shippedAt: null });

      return 'claimed' as const;
    },
    release: (ticketId: string): void => {
      const row = rows.get(ticketId);

      if (row?.runnerId === runnerId && row.shippedAt === null) {
        rows.delete(ticketId);
      }
    },
    shipped: (ticketId: string): void => {
      const row = rows.get(ticketId);

      if (row?.runnerId === runnerId) {
        rows.set(ticketId, { ...row, shippedAt: Date.now() });
      }
    },
  });

  return { rows, state, forRunner };
};

/** A pods root with one active building pod on `runnerId`. */
export const buildingPodStore = (
  podId = 'build-a1b2',
  runnerId = 'r-leslie-mac',
  extra: Record<string, unknown> = {}
): { store: PodStore; root: string; podId: string } => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-building-'))
  );
  const store = createPodStore(path.join(root, '.lambda', 'pods'));
  fs.mkdirSync(store.root, { recursive: true });
  store.writePod({
    id: podId,
    slug: 'build',
    createdAt: '2026-10-23T10:00:00.000Z',
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: root,
    ownsWorktree: false,
    managerCwd: path.join(root, '.lambda', 'managers', podId),
    devCwd: root,
    agentCommand: 'claude',
    sessions: {
      'engineering-manager': 'em-session',
      dev: 'dev-session',
      qa: 'qa-session',
      'product-manager': 'pm-session',
    },
    kind: 'building',
    runnerId,
    ...extra,
  });

  return { store, root, podId };
};
