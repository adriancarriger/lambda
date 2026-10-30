import type { TicketListItem } from '../shared/building';
import { iconEmoji } from '../shared/emoji';
import {
  NO_SETTINGS,
  decodeSettings,
  encodeSettings,
  favoriteRef,
  listSettingsOf,
  sameSettings,
  splitFavoriteRef,
  viewCounts,
} from '../shared/savedViews';

/**
 * Saved views as the client uses them: the address's `?filter=`, the
 * comparison that offers Save, a view panel's counts, and the icons Linear
 * keeps as shortcodes.
 */

const item = (
  id: string,
  extra: Partial<TicketListItem> = {}
): TicketListItem => ({
  id,
  title: `Ticket ${id}`,
  status: 'ready',
  parent: null,
  labels: [],
  url: null,
  projectId: 'parks',
  source: 'linear',
  ...extra,
});

describe('?filter=', () => {
  it('round-trips settings, any text included', () => {
    const settings = {
      groupBy: 'assignee' as const,
      chips: [
        { field: 'project' as const, value: 'Lil’ Sebastian memorial 🐴' },
        { field: 'label' as const, value: 'bug' },
      ],
    };
    const encoded = encodeSettings(settings);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSettings(encoded)).toEqual(settings);
  });

  it('reads a missing or foreign filter as none', () => {
    expect(decodeSettings(null)).toBeNull();
    expect(decodeSettings('')).toBeNull();
    expect(decodeSettings('not base64 json!')).toBeNull();
  });

  it('drops a field or grouping it does not know', () => {
    expect(
      listSettingsOf({
        groupBy: 'cycle',
        chips: [
          { field: 'cycle', value: '12' },
          { field: 'label', value: 'bug' },
          { field: 'status', value: 3 },
        ],
      })
    ).toEqual({ groupBy: 'status', chips: [{ field: 'label', value: 'bug' }] });
  });
});

describe('sameSettings', () => {
  it('ignores the order of filters, not the grouping', () => {
    const a = {
      groupBy: 'status' as const,
      chips: [
        { field: 'label' as const, value: 'bug' },
        { field: 'priority' as const, value: 'high' },
      ],
    };

    expect(sameSettings(a, { ...a, chips: [...a.chips].reverse() })).toBe(true);
    expect(sameSettings(a, { ...a, groupBy: 'project' })).toBe(false);
    expect(sameSettings(a, NO_SETTINGS)).toBe(false);
  });
});

describe('viewCounts', () => {
  const items = [
    item('1', {
      assignee: "Leslie's MacBook",
      labels: ['bug'],
      project: 'Lot 48',
    }),
    item('2', { assignee: "Leslie's MacBook", labels: ['bug', 'parks'] }),
    item('3', { labels: ['parks'], project: 'Lot 48' }),
    item('4', { assignee: 'Ann Perkins', project: 'Harvest festival' }),
  ];

  it('counts by assignee, the unassigned last', () => {
    expect(viewCounts(items, 'assignee')).toEqual([
      { key: "Leslie's MacBook", label: "Leslie's MacBook", count: 2 },
      { key: 'Ann Perkins', label: 'Ann Perkins', count: 1 },
      { key: '', label: 'No assignee', count: 1 },
    ]);
  });

  it('counts each label a ticket has', () => {
    expect(
      viewCounts(items, 'label').map((one) => [one.key, one.count])
    ).toEqual([
      ['bug', 2],
      ['parks', 2],
    ]);
  });

  it('counts by project', () => {
    expect(
      viewCounts(items, 'project').map((one) => [one.label, one.count])
    ).toEqual([
      ['Lot 48', 2],
      ['Harvest festival', 1],
      ['No project', 1],
    ]);
  });
});

describe('favorite refs', () => {
  it("keep a project's name whole, slashes and all", () => {
    expect(splitFavoriteRef(favoriteRef('parks', 'Q3 / Q4 launch'))).toEqual({
      codebaseId: 'parks',
      name: 'Q3 / Q4 launch',
    });
  });
});

describe('iconEmoji', () => {
  it("draws Linear's shortcodes and typed emoji, not its icon names", () => {
    expect(iconEmoji(':bee:')).toBe('🐝');
    expect(iconEmoji(':Rocket:')).toBe('🚀');
    expect(iconEmoji('🦇')).toBe('🦇');
    expect(iconEmoji('FaceId')).toBeNull();
    expect(iconEmoji(':not_a_shortcode:')).toBeNull();
    expect(iconEmoji(null)).toBeNull();
    expect(iconEmoji('')).toBeNull();
  });
});
