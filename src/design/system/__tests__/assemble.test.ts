import {
  type AssembleInput,
  BUNDLE_JS,
  INDEX,
  MAX_BUNDLE_BYTES,
  README,
  assembleSystem,
  bundleHeader,
  checkBundle,
} from '../assemble';
import { type TokensJson } from '../tokens';

const NAMESPACE = 'PawneeParksMap';
const HEADER = bundleHeader(NAMESPACE, ['ParkCard']);
const BODY =
  '(function(){var h=window.React.createElement;window.PawneeParksMap={Root:function(p){return h("div",null,p.children)},ParkCard:function(p){return h("div",null,p.name)}};})();';

const tokens: TokensJson = {
  name: 'Pawnee parks map',
  version: 1,
  color: {
    themes: [
      { id: 'light', name: 'Light' },
      { id: 'dark', name: 'Dark' },
    ],
    tokens: [
      { name: 'park-green', value: { light: '#2f855a', dark: '#2f855a' } },
    ],
  },
  spacing: { tokens: [] },
  radius: { tokens: [] },
  meta: { source: 'tailwind', ref: 'a1b2c3d', components: {} },
};

const input = (overrides: Partial<AssembleInput> = {}): AssembleInput => ({
  namespace: NAMESPACE,
  title: 'Pawnee parks map',
  bundle: {
    js: `${HEADER}\n${BODY}`,
    css: '.park{}',
    components: ['ParkCard'],
  },
  tokens,
  skipped: [],
  catalog: [
    {
      name: 'ParkCard',
      summary: 'One park and its opening hours.',
      props: { name: 'string' },
      example: { component: 'ParkCard', props: { name: 'Pawnee Commons' } },
    },
  ],
  patterns: [{ file: 'MapView.tsx', copies: ['src/features/map/MapView.tsx'] }],
  leftOut: [{ name: 'LotFortyEight', why: 'it loads the city zoning API' }],
  screens: [],
  screenFiles: {},
  source: 'code',
  version: 3,
  sha: 'a1b2c3d',
  at: '2026-10-01T09:00:00-05:00',
  createdAt: '2026-09-01T09:00:00-05:00',
  ...overrides,
});

/** A bundle of exactly `bytes` bytes, header first. */
const bundleOf = (bytes: number): string => {
  const head = `${HEADER}\n${BODY}\n/*`;
  const tail = '*/';

  return `${head}${'x'.repeat(bytes - head.length - tail.length)}${tail}`;
};

describe('checkBundle', () => {
  it.each([
    ['</script', `${HEADER}\n${BODY}\nvar s="</script>";`, 'no </script'],
    ['<!--', `${HEADER}\n${BODY}\nvar s="<!--";`, 'no <!--'],
    [
      'a top-level import',
      `${HEADER}\nimport x from "react";\n${BODY}`,
      'one classic script',
    ],
    [
      'a process.env read',
      `${HEADER}\n${BODY}\nvar k=process.env.PARKS_KEY;`,
      'no process.env',
    ],
    ['no @ds-bundle header on line 1', `${BODY}\n${HEADER}`, 'header'],
  ])('throws naming its rule for %s', (_label, bundle, rule) => {
    expect(() => checkBundle(bundle, NAMESPACE)).toThrow(
      `Bundle rule "${rule}"`
    );
  });

  it.each([
    [
      'code outside one IIFE',
      `${HEADER}\nwindow.PawneeParksMap={};var parks=1;`,
      'one IIFE',
    ],
    ['two scripts glued together', `${HEADER}\n${BODY}var late=1;`, 'one IIFE'],
    [
      'an IIFE that never assigns window.PawneeParksMap',
      `${HEADER}\n(function(){window.Eagleton={};})();`,
      'assigns window.PawneeParksMap',
    ],
  ])('throws naming its rule for %s', (_label, bundle, rule) => {
    expect(() => checkBundle(bundle, NAMESPACE)).toThrow(
      `Bundle rule "${rule}"`
    );
  });

  it.each([
    ['import x from', `${HEADER}\n${BODY}\nimport x from "react";`],
    ['import{', `${HEADER}\n${BODY};import{a}from"react";`],
    ['import"', `${HEADER}\n${BODY};import"react";`],
    ['import*as', `${HEADER}\n${BODY};import*as r from"react";`],
  ])('finds the top-level import %s', (_label, bundle) => {
    expect(() => checkBundle(bundle, NAMESPACE)).toThrow(
      'Bundle rule "one classic script"'
    );
  });

  it.each([
    [
      'an object key named important',
      '(()=>{var a={important:!0};window.PawneeParksMap=a;})();',
    ],
    [
      'a call to importScripts',
      '(()=>{if(0){importScripts("parks.js")}window.PawneeParksMap={};})();',
    ],
  ])('is no import: %s', (_label, body) => {
    expect(checkBundle(`${HEADER}\n${body}`, NAMESPACE)).toEqual([]);
  });

  it.each([
    [
      'an esbuild arrow IIFE',
      '"use strict";(()=>{window.PawneeParksMap={};})();',
    ],
    [
      'an Object.assign onto window',
      '(()=>{var a={};Object.assign(window,{PawneeParksMap:a});})();',
    ],
    ['a bracket assignment', "!function(){window['PawneeParksMap']={}}();"],
    [
      'a minified IIFE holding a URL (its // is no comment)',
      '(()=>{fetch("https://api.pawnee.gov/parks");window.PawneeParksMap={};})();',
    ],
  ])('accepts %s', (_label, body) => {
    expect(checkBundle(`${HEADER}\n${body}`, NAMESPACE)).toEqual([]);
  });

  it.each([
    [
      'format 3',
      '/* @ds-bundle: {"format":3,"namespace":"PawneeParksMap","components":[{"name":"ParkCard"}]} */',
      'format must be 4',
    ],
    [
      'no components list',
      '/* @ds-bundle: {"format":4,"namespace":"PawneeParksMap"} */',
      'components must be a list of { name }',
    ],
    [
      'a component with no name',
      '/* @ds-bundle: {"format":4,"namespace":"PawneeParksMap","components":[{"title":"ParkCard"}]} */',
      'components must be a list of { name }',
    ],
    [
      'a component listed twice',
      '/* @ds-bundle: {"format":4,"namespace":"PawneeParksMap","components":[{"name":"ParkCard"},{"name":"ParkCard"}]} */',
      'components lists ParkCard twice',
    ],
  ])(
    'refuses a header with %s, naming the header rule',
    (_label, header, what) => {
      expect(() => checkBundle(`${header}\n${BODY}`, NAMESPACE)).toThrow(
        `Bundle rule "header": the @ds-bundle header's ${what}`
      );
    }
  );

  it('refuses a header naming another namespace', () => {
    expect(() =>
      checkBundle(`${bundleHeader('Eagleton', [])}\n${BODY}`, NAMESPACE)
    ).toThrow('the @ds-bundle header must name namespace PawneeParksMap');
  });

  it('refuses 6 MB + 1 byte with the exact size message', () => {
    const bundle = bundleOf(MAX_BUNDLE_BYTES + 1);
    expect(Buffer.byteLength(bundle)).toBe(MAX_BUNDLE_BYTES + 1);
    expect(() => checkBundle(bundle, NAMESPACE)).toThrow(
      'The components bundle is 6.00 MB. Claude Design takes at most 6 MB. Leave some out with design.systemBuild.exclude in lambda.json.'
    );
  });

  it('accepts exactly 6 MB with one warning', () => {
    expect(checkBundle(bundleOf(MAX_BUNDLE_BYTES), NAMESPACE)).toHaveLength(1);
  });

  it('warns once over 2 MB, and not at 2 MB', () => {
    const twoMb = 2 * 1024 * 1024;
    expect(checkBundle(bundleOf(twoMb + 1), NAMESPACE)).toEqual([
      'The components bundle is 2.00 MB, over 2 MB: an open canvas loads it only after a reload.',
    ]);
    expect(checkBundle(bundleOf(twoMb), NAMESPACE)).toEqual([]);
  });
});

describe('assembleSystem', () => {
  it('throws on a bundle that breaks a rule', () => {
    expect(() =>
      assembleSystem(
        input({
          bundle: {
            js: `${HEADER}\n${BODY}<!--`,
            css: '',
            components: ['ParkCard'],
          },
        })
      )
    ).toThrow('Bundle rule "no <!--"');
  });

  it('writes the README and index a canvas consumes', () => {
    const { files, warnings } = assembleSystem(input());
    const readme = files[README] ?? '';

    expect(warnings).toEqual([]);
    expect(readme).toContain("The bundle's global is `window.PawneeParksMap`.");
    expect(readme).toContain(
      '## Copied by hand\n\n- `patterns/MapView.tsx` copies `src/features/map/MapView.tsx`\n'
    );
    expect(readme).toContain(
      '## Left out\n\n- `LotFortyEight`: it loads the city zoning API\n'
    );
    const headings = readme
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(headings.at(-1)).toBe('## Consuming this system');
    expect(readme.trimEnd().split('\n').at(-1)).toBe(
      "- Wrap everything in `PawneeParksMap.Root`; a component outside it renders without the app's theme."
    );

    const index: unknown = JSON.parse(files[INDEX] ?? '');
    expect(index).toMatchObject({
      v: 3,
      layout: 'files',
      title: 'Pawnee parks map',
      namespace: NAMESPACE,
      createdOnFiles: { v: 1, at: '2026-09-01T09:00:00-05:00' },
      libraries: [
        { name: 'react', version: '18' },
        { name: 'react-dom', version: '18' },
      ],
      lastChange: {
        by: 'lambda',
        at: '2026-10-01T09:00:00-05:00',
        via: 'lambda design system · v3 · a1b2c3d',
      },
    });
    expect(Object.keys(files).at(-1)).toBe(INDEX);
    expect(files[BUNDLE_JS]).toBe(`${HEADER}\n${BODY}`);
    expect(files['project/components/ParkCard/preview.html']).toContain(
      'window.PawneeParksMap'
    );
    expect(files['project/components/Cover/preview.html']).toContain(
      'var(--park-green)'
    );
  });

  it('says why there is no bundle, and writes no components', () => {
    const { files } = assembleSystem(
      input({ bundle: undefined, noBundleReason: 'No React here.' })
    );

    expect(files[README]).toContain('## Components\n\nNo React here.\n');
    expect(
      Object.keys(files).filter((file) => file.includes('/components/'))
    ).toEqual([]);
  });

  it('opens a photos-only README with the photos line', () => {
    const { files } = assembleSystem(
      input({ bundle: undefined, source: 'photos' })
    );

    expect((files[README] ?? '').split('\n')[0]).toBe(
      "Built from photos only: Lambda couldn't find this app's theme or components in the code."
    );
  });

  it('refuses a screen the index lists that has no file', () => {
    expect(() =>
      assembleSystem(
        input({
          screens: [
            {
              file: 'ParkMap.dc.html',
              title: 'Park map',
              route: '/parks',
              summary: 'Every park.',
              situations: [{ slug: 'list', title: 'List' }],
              path: [],
              scenario: 'parks-map',
            },
          ],
        })
      )
    ).toThrow(
      'screens/index.ts lists ParkMap.dc.html, but screens/ has no such file.'
    );
  });

  it.each([['Tabs.List'], ['../Evil']])(
    'refuses a catalog entry named %s, naming it',
    (name) => {
      expect(() =>
        assembleSystem(
          input({
            catalog: [
              {
                name,
                summary: 'Not a component name.',
                props: {},
                example: { component: 'ParkCard', props: {} },
              },
            ],
          })
        )
      ).toThrow(`catalog.ts lists "${name}"`);
    }
  );

  it('gives the same bytes for the same input', () => {
    expect(assembleSystem(input())).toEqual(assembleSystem(input()));
  });
});
