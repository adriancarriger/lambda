import { appRuntimeProblems } from '../checks';

const ENTRY = '.lambda/design-system/index.tsx';

describe('the app runtime check, over a hand-written metafile', () => {
  it("still names app runtime when the metafile doesn't name the entry", () => {
    // The codebase's own build ran from .lambda/: every input is keyed from there.
    const metafile = {
      inputs: {
        'design-system/index.tsx': {
          imports: [{ path: '../src/components/MapView.tsx' }],
        },
        '../src/components/MapView.tsx': {
          imports: [{ path: '../node_modules/mixpanel-browser/lib/index.js' }],
        },
        '../node_modules/mixpanel-browser/lib/index.js': { imports: [] },
      },
    };

    expect(
      appRuntimeProblems({
        metafile,
        entry: ENTRY,
        entryText: "export { MapView } from '../src/components/MapView';\n",
        exclude: [],
      })
    ).toEqual([`${ENTRY} loads mixpanel-browser.`]);
  });

  it('names a component re-exported with export *', () => {
    const metafile = {
      inputs: {
        [ENTRY]: {
          imports: [
            {
              path: 'src/components/MapView.tsx',
              original: '../../src/components/MapView',
            },
          ],
        },
        'src/components/MapView.tsx': {
          imports: [{ path: 'node_modules/mixpanel-browser/lib/index.js' }],
        },
        'node_modules/mixpanel-browser/lib/index.js': { imports: [] },
      },
    };

    expect(
      appRuntimeProblems({
        metafile,
        entry: ENTRY,
        entryText: "export * from '../../src/components/MapView';\n",
        exclude: [],
      })
    ).toEqual(['MapView loads mixpanel-browser.']);
  });

  it('keeps an import bound when an export statement comes before it', () => {
    const metafile = {
      inputs: {
        [ENTRY]: {
          imports: [
            {
              path: 'src/components/ParkMap.tsx',
              original: './ParkMap',
            },
          ],
        },
        'src/components/ParkMap.tsx': {
          imports: [{ path: 'node_modules/mixpanel-browser/lib/index.js' }],
        },
        'node_modules/mixpanel-browser/lib/index.js': { imports: [] },
      },
    };

    expect(
      appRuntimeProblems({
        metafile,
        entry: ENTRY,
        entryText: [
          "export const town = 'Pawnee';",
          "import LotFortyEight from './ParkMap';",
          'export { LotFortyEight };',
          '',
        ].join('\n'),
        exclude: [],
      })
    ).toEqual(['LotFortyEight loads mixpanel-browser.']);
  });

  it('walks a very deep import chain without running out of stack', () => {
    const depth = 20_000;
    const link = (index: number): string => `src/trail/step${index}.ts`;
    const inputs: Record<
      string,
      { imports: { path: string; original?: string }[] }
    > = {
      [ENTRY]: {
        imports: [{ path: link(0), original: './trail' }],
      },
      'node_modules/mixpanel-browser/lib/index.js': { imports: [] },
    };
    Array.from({ length: depth }, (_, index) => index).forEach((index) => {
      inputs[link(index)] = {
        imports: [
          {
            path:
              index === depth - 1
                ? 'node_modules/mixpanel-browser/lib/index.js'
                : link(index + 1),
          },
        ],
      };
    });

    expect(
      appRuntimeProblems({
        metafile: { inputs },
        entry: ENTRY,
        entryText: "import { Trail } from './trail';\n",
        exclude: [],
      })
    ).toEqual(['Trail loads mixpanel-browser.']);
  });
});

describe('the app runtime packages', () => {
  it("names a listed package's siblings and scope too", () => {
    const adapter = '@next-auth/prisma-adapter';
    const metafile = {
      inputs: {
        [ENTRY]: {
          imports: [
            { path: 'src/components/SignIn.tsx', original: './SignIn' },
          ],
        },
        'src/components/SignIn.tsx': {
          imports: [
            { path: 'node_modules/mixpanel-browser/index.js' },
            { path: `node_modules/${adapter}/index.js` },
          ],
        },
        'node_modules/mixpanel-browser/index.js': { imports: [] },
        [`node_modules/${adapter}/index.js`]: { imports: [] },
      },
    };

    expect(
      appRuntimeProblems({
        metafile,
        entry: ENTRY,
        entryText: "export { SignIn } from './SignIn';\n",
        exclude: [],
      })
    ).toEqual(['SignIn loads mixpanel-browser.', `SignIn loads ${adapter}.`]);
  });
});
