import {
  formatRoute,
  itemSlug,
  lambdaFromSlug,
  lambdaSlugs,
  parseRoute,
  questionFromSlug,
  slugify,
} from '../shared/route';

describe('routes — every screen has a URL, and back', () => {
  it.each([
    ['/', { page: 'new' }],
    ['/time', { page: 'time' }],
    ['/tickets', { page: 'tickets' }],
    [
      '/tickets/prj_parks/PAWNEE-2a',
      { page: 'tickets', project: 'prj_parks', ticket: 'PAWNEE-2a' },
    ],
    ['/projects', { page: 'projects' }],
    [
      '/projects/prj_parks/Harvest%20festival',
      { page: 'project', codebase: 'prj_parks', name: 'Harvest festival' },
    ],
    [
      '/projects/prj_parks/Lot%2048?filter=eyJncm91cEJ5Ijoic3RhdHVzIn0',
      {
        page: 'project',
        codebase: 'prj_parks',
        name: 'Lot 48',
        filter: 'eyJncm91cEJ5Ijoic3RhdHVzIn0',
      },
    ],
    ['/views', { page: 'views' }],
    ['/views/view_queue', { page: 'view', id: 'view_queue' }],
    [
      '/views/view_queue?filter=eyJncm91cEJ5Ijoic3RhdHVzIn0',
      { page: 'view', id: 'view_queue', filter: 'eyJncm91cEJ5Ijoic3RhdHVzIn0' },
    ],
    ['/computers', { page: 'account', which: 'computers' }],
    ['/analytics', { page: 'account', which: 'analytics' }],
    ['/settings/devices', { page: 'account', which: 'settings/devices' }],
    ['/settings/process', { page: 'account', which: 'settings/process' }],
    [
      '/settings/design-system',
      { page: 'account', which: 'settings/design-system' },
    ],
    ['/auto/caught-up', { page: 'auto' }],
    ['/work/pod%3Aplan-parks', { page: 'work', lambda: 'pod:plan-parks' }],
    [
      '/work/ticket%3Aprj_parks%2FPAWNEE-4',
      { page: 'work', lambda: 'ticket:prj_parks/PAWNEE-4' },
    ],
    [
      '/auto/dog-park-map/checkpoint-4',
      { page: 'auto', lambda: 'dog-park-map', item: 'checkpoint-4' },
    ],
    ['/lambda/dog-park-map', { page: 'lambda', lambda: 'dog-park-map' }],
    [
      '/lambda/dog-park-map/decision-7?v=3',
      {
        page: 'lambda',
        lambda: 'dog-park-map',
        item: 'decision-7',
        version: 3,
      },
    ],
  ])('%s', (url, route) => {
    const [pathname, search] = url.split('?');
    expect(
      parseRoute(pathname ?? '/', search === undefined ? '' : `?${search}`)
    ).toEqual(expect.objectContaining(route));
    expect(
      formatRoute(
        parseRoute(pathname ?? '/', search === undefined ? '' : `?${search}`)
      )
    ).toBe(url);
  });

  it('a bare /settings is Settings → Devices', () => {
    expect(formatRoute(parseRoute('/settings'))).toBe('/settings/devices');
  });

  it('anything unknown is the front door', () => {
    expect(parseRoute('/whatever/else')).toEqual({ page: 'new' });
    expect(parseRoute('/lambda')).toEqual({ page: 'new' });
  });
});

describe('readable names', () => {
  it('slugifies a Lambda name', () => {
    expect(slugify('Duck pond water & trail markers!')).toBe(
      'duck-pond-water-trail-markers'
    );
    expect(slugify('Café jardinière')).toBe('cafe-jardiniere');
  });

  it('keeps clashing names apart, and finds a Lambda by name, id or slug', () => {
    const lambdas = [
      { id: 'pawnee-a1b2', name: 'Pawnee parks' },
      { id: 'pawnee-c3d4', name: 'Pawnee parks' },
      { id: 'eagleton-e5f6', name: 'Eagleton' },
    ];
    const slugs = lambdaSlugs(lambdas);

    expect(slugs.get('pawnee-a1b2')).toBe('pawnee-parks-a1b2');
    expect(slugs.get('pawnee-c3d4')).toBe('pawnee-parks-c3d4');
    expect(slugs.get('eagleton-e5f6')).toBe('eagleton');
    expect(lambdaFromSlug('eagleton', lambdas)).toBe('eagleton-e5f6');
    expect(lambdaFromSlug('pawnee-c3d4', lambdas)).toBe('pawnee-c3d4');
    expect(lambdaFromSlug('pawnee-parks', lambdas)).toBeUndefined();
  });

  it('names items, and finds them again', () => {
    expect(itemSlug({ kind: 'checkpoint', qid: 'q4' }, 4)).toBe('checkpoint-4');
    expect(itemSlug({ kind: 'question', qid: 'q7' })).toBe('decision-7');
    expect(itemSlug({ kind: 'reply' })).toBe('your-turn');
    expect(itemSlug({ kind: 'structure' })).toBe('structured-planning');

    const questions = [
      { id: 'q2', status: 'closed', checkpoint: { cp: 4 } },
      { id: 'q4', status: 'open', checkpoint: { cp: 4 } },
      { id: 'q7', status: 'open' },
    ];
    expect(questionFromSlug('checkpoint-4', questions)?.id).toBe('q4');
    expect(questionFromSlug('decision-7', questions)?.id).toBe('q7');
    expect(questionFromSlug('decision-9', questions)).toBeUndefined();
  });
});
