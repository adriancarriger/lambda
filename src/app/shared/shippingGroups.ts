/**
 * "Shipping together" groups: tickets a project ships as one (it holds them
 * until, say, the epic completes). They come only from the project's own
 * `group.*` events; with none there is no group, and Lambda never makes one.
 */

export interface GroupEvent {
  type: string;
  groupId?: string | null;
  ticket?: string | null;
  reason?: string | null;
  held?: boolean | null;
  at: string | number;
  /** Where it came from in events.jsonl, for an unknown type's warning. */
  line?: number;
}

export interface ShippingGroup {
  id: string;
  tickets: string[];
  held: boolean;
  /** "Ships when the epic completes, 1 left"; null until one is reported. */
  reason: string | null;
  /** `shipping` once `group.shipping` arrives. */
  state: 'open' | 'shipping';
}

export interface ShippingGroups {
  /** Groups with no `group.shipped` yet, oldest first. */
  open: ShippingGroup[];
  /** Every ticket of a shipped group: each is done when its group ships. */
  shippedTickets: string[];
  /** `group.*` lines of a type nobody knows, by line number. */
  unknown: { type: string; line?: number }[];
  /** The open group a ticket is in. */
  groupOf: (ticketId: string) => ShippingGroup | undefined;
}

export const GROUP_TYPES = [
  'group.add',
  'group.reason',
  'group.hold',
  'group.release',
  'group.shipping',
  'group.shipped',
] as const;

const isGroupType = (type: string): boolean =>
  GROUP_TYPES.some((known) => known === type);

const timeOf = (at: string | number): number =>
  typeof at === 'number' ? at : Date.parse(at);

interface Fold {
  open: Map<string, ShippingGroup>;
  shipped: string[];
  unknown: { type: string; line?: number }[];
}

const apply = (fold: Fold, event: GroupEvent): Fold => {
  if (!event.type.startsWith('group.')) {
    return fold;
  }

  if (!isGroupType(event.type)) {
    return {
      ...fold,
      unknown: [
        ...fold.unknown,
        {
          type: event.type,
          ...(event.line === undefined ? {} : { line: event.line }),
        },
      ],
    };
  }

  const id = event.groupId ?? null;

  if (id === null || id === '') {
    return fold;
  }

  const current = fold.open.get(id) ?? {
    id,
    tickets: [],
    held: false,
    reason: null,
    state: 'open' as const,
  };
  const open = new Map(fold.open);
  const ticket = event.ticket ?? null;

  switch (event.type) {
    case 'group.add':
      open.set(id, {
        ...current,
        tickets:
          ticket === null || current.tickets.includes(ticket)
            ? current.tickets
            : [...current.tickets, ticket],
      });

      return { ...fold, open };
    case 'group.reason':
      open.set(id, { ...current, reason: event.reason ?? null });

      return { ...fold, open };
    case 'group.hold':
      open.set(id, { ...current, held: event.held ?? true });

      return { ...fold, open };
    case 'group.release':
      open.set(id, { ...current, held: false });

      return { ...fold, open };
    case 'group.shipping':
      open.set(id, { ...current, state: 'shipping' });

      return { ...fold, open };
    default:
      // group.shipped: the group is gone, and its tickets are done.
      open.delete(id);

      return {
        ...fold,
        open,
        shipped: [
          ...fold.shipped,
          ...current.tickets.filter((one) => !fold.shipped.includes(one)),
        ],
      };
  }
};

/** Fold the events, in time order, into the groups as they stand. */
export const shippingGroups = (events: GroupEvent[]): ShippingGroups => {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) => timeOf(a.event.at) - timeOf(b.event.at) || a.index - b.index
    )
    .map(({ event }) => event);
  const fold = ordered.reduce(apply, {
    open: new Map<string, ShippingGroup>(),
    shipped: [],
    unknown: [],
  });
  const open = [...fold.open.values()];

  return {
    open,
    shippedTickets: fold.shipped,
    unknown: fold.unknown,
    groupOf: (ticketId) =>
      open.find((group) => group.tickets.includes(ticketId)),
  };
};
