import { type ManifestSource } from './manifest';
import { type SkippedToken, type TokensJson } from './tokens';

/**
 * Every file of a built design system, laid out as the Design System type
 * keeps one in files (`project/…`): the index, the README, the tokens, and
 * with a bundle the components, one README and preview per catalog entry,
 * the sample data and the reference screens. Pure: the build reads the
 * project and hands everything in, so the same input gives the same bytes.
 *
 * Nothing here holds a clock time, a path on this computer or a machine
 * name: `lastChange.at` and `createdOnFiles.at` are commit dates, and
 * `lastChange.by` is `lambda`.
 */

export const INDEX = 'project/design-system.json';
export const README = 'project/README.md';
export const TOKENS = 'project/tokens.json';
export const SAMPLE_DATA_FILE = 'project/sample-data.js';
export const SCREENS_DIR = 'project/screens';
export const SCREENS_PAGE = 'project/Screens.md';
export const BUNDLE_JS = 'project/components/bundle.js';
export const BUNDLE_CSS = 'project/components/bundle.css';

const MB = 1024 * 1024;
export const MAX_BUNDLE_BYTES = 6 * MB;
const RELOAD_BUNDLE_BYTES = 2 * MB;

export type ExampleNode =
  | string
  | {
      component: string;
      props?: Record<string, unknown>;
      children?: ExampleNode[];
    };

/** One entry of the design system's `catalog.ts`. */
export interface CatalogEntry {
  name: string;
  summary: string;
  props: Record<string, string>;
  example: ExampleNode;
  usage?: string;
  group?: string;
  height?: number;
  width?: number;
  rootProps?: Record<string, string>;
}

/** One reference screen, as `screens/index.ts` lists it. */
export interface ReferenceScreen {
  file: string;
  title: string;
  route: string;
  summary: string;
  situations: { slug: string; title: string }[];
  path: { step: string; action: string }[];
  scenario: string;
  phone?: boolean;
}

export interface PatternCopy {
  file: string;
  /** The app files it copies (sources.json). */
  copies: string[];
}

export interface AssembleInput {
  namespace: string;
  /** The project's name: the system's title. */
  title: string;
  /** Absent: a look-only or photos-only system. */
  bundle?: { js: string; css: string; components: string[] };
  /** Why there is no bundle, in one line, for the README. */
  noBundleReason?: string;
  tokens: TokensJson;
  skipped: SkippedToken[];
  catalog: CatalogEntry[];
  patterns: PatternCopy[];
  leftOut: { name: string; why: string }[];
  sampleData?: unknown;
  screens: ReferenceScreen[];
  screenFiles: Record<string, string>;
  source: ManifestSource;
  version?: number;
  /** Short sha of the commit built. */
  sha: string;
  /** Committer date of the commit built. */
  at: string;
  /** Committer date of the commit that first added the manifest. */
  createdAt: string;
}

/** The bundle rules a canvas holds it to; throws naming the rule, returns warnings. */
export const checkBundle = (bundle: string, namespace: string): string[] => {
  const [firstLine = ''] = bundle.split('\n', 1);
  const header = /^\/\* @ds-bundle: (\{.*\}) \*\/$/.exec(firstLine);

  if (header === null) {
    throw new Error(
      'Bundle rule "header": line 1 of bundle.js must be the /* @ds-bundle: {…} */ header.'
    );
  }

  const parsed: unknown = JSON.parse(header[1] ?? '{}');

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('namespace' in parsed) ||
    parsed.namespace !== namespace
  ) {
    throw new Error(
      `Bundle rule "header": the @ds-bundle header must name namespace ${namespace}.`
    );
  }

  if (!('format' in parsed) || parsed.format !== 4) {
    throw new Error(
      `Bundle rule "header": the @ds-bundle header's format must be 4, not ${JSON.stringify(
        'format' in parsed ? parsed.format : undefined
      )}.`
    );
  }

  const components: unknown =
    'components' in parsed ? parsed.components : undefined;

  if (
    !Array.isArray(components) ||
    !components.every(
      (one: unknown) =>
        typeof one === 'object' &&
        one !== null &&
        'name' in one &&
        typeof one.name === 'string' &&
        one.name !== ''
    )
  ) {
    throw new Error(
      `Bundle rule "header": the @ds-bundle header's components must be a list of { name }.`
    );
  }

  const names: string[] = components.map((one: { name: string }) => one.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);

  if (twice !== undefined) {
    throw new Error(
      `Bundle rule "header": the @ds-bundle header's components lists ${twice} twice.`
    );
  }

  if (/<\/script/i.test(bundle)) {
    throw new Error(
      'Bundle rule "no </script": bundle.js contains a literal </script (a canvas inlines it).'
    );
  }

  if (bundle.includes('<!--')) {
    throw new Error(
      'Bundle rule "no <!--": bundle.js contains a literal <!-- (a canvas inlines it).'
    );
  }

  // `import` as a whole word: never `important:` or `importScripts(`.
  if (/(^|[\n;{}])\s*import(\s+[\w{*]|\s*[{*'"])/.test(bundle)) {
    throw new Error(
      'Bundle rule "one classic script": bundle.js has a top-level import.'
    );
  }

  if (/\bprocess\.env\b/.test(bundle)) {
    throw new Error(
      'Bundle rule "no process.env": bundle.js reads process.env, which throws "process is not defined" on a canvas.'
    );
  }

  // After the header: one IIFE, a "use strict" and trailing comment lines
  // aside. (Only whole comment lines: a minified bundle is one line, and a
  // `//` inside it may be a URL.)
  const code = bundle
    .slice(firstLine.length)
    .replace(/(\n[ \t]*(\/\*[\s\S]*?\*\/|\/\/[^\n]*))*\s*$/, '')
    .trim()
    .replace(/^(["'])use strict\1;?\s*/, '');

  if (
    !/^(\(\s*(async\s*)?\(\s*\)\s*=>|\(\s*function\b|!\s*function\b)/.test(
      code
    ) ||
    !/\)\s*;?$/.test(code)
  ) {
    throw new Error(
      'Bundle rule "one IIFE": bundle.js must be one immediately-invoked function after its header, with nothing outside it.'
    );
  }

  const assigns = new RegExp(
    [
      `window\\.${namespace}\\s*=`,
      `window\\[\\s*["']${namespace}["']\\s*\\]\\s*=`,
      `Object\\.assign\\(\\s*window\\s*,\\s*\\{[^}]*\\b${namespace}\\b`,
    ].join('|')
  );

  if (!assigns.test(code)) {
    throw new Error(
      `Bundle rule "assigns window.${namespace}": bundle.js never assigns window.${namespace}, the global a canvas mounts from.`
    );
  }

  const bytes = Buffer.byteLength(bundle);

  if (bytes > MAX_BUNDLE_BYTES) {
    throw new Error(
      `The components bundle is ${(bytes / MB).toFixed(
        2
      )} MB. Claude Design takes at most 6 MB. Leave some out with design.systemBuild.exclude in lambda.json.`
    );
  }

  return bytes > RELOAD_BUNDLE_BYTES
    ? [
        `The components bundle is ${(bytes / MB).toFixed(
          2
        )} MB, over 2 MB: an open canvas loads it only after a reload.`,
      ]
    : [];
};

/** The bundle's first line. */
export const bundleHeader = (namespace: string, components: string[]): string =>
  `/* @ds-bundle: ${JSON.stringify({
    format: 4,
    namespace,
    components: components.map((name) => ({ name })),
  })} */`;

/** JSON for an inline <script>: no `<` survives, so no `</script` or `<!--`. */
export const inlineJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c');

export const previewHtml = (entry: CatalogEntry, namespace: string): string => {
  const marker = `<!-- @dsCard group="${entry.group ?? 'Components'}" height=${
    entry.height ?? 160
  }${entry.width === undefined ? '' : ` width=${entry.width}`} -->`;

  return `${marker}
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${entry.name} — preview</title>
<style>html, body, #root { margin: 0; height: 100%; }</style>
</head>
<body>
<div id="root"></div>
<script>
  var N = window.${namespace}, h = React.createElement;
  var example = ${inlineJson(entry.example)};
  var rootProps = ${inlineJson(entry.rootProps ?? {})};
  function isNode(value) {
    return value !== null && typeof value === 'object' && typeof value.component === 'string';
  }
  function resolve(value) {
    if (value === '$noop') return function () {};
    if (isNode(value)) return build(value);
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) { out[key] = resolve(value[key]); });
      return out;
    }
    return value;
  }
  function build(node) {
    if (typeof node === 'string') return node;
    var props = resolve(node.props || {});
    var type = /^[a-z]/.test(node.component) ? node.component : N[node.component];
    return h.apply(null, [type, props].concat((node.children || []).map(build)));
  }
  var mode = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  ReactDOM.createRoot(document.getElementById('root')).render(
    h(N.Root, Object.assign({ mode: mode }, rootProps), build(example))
  );
</script>
</body>
</html>
`;
};

const componentReadme = (entry: CatalogEntry, namespace: string): string =>
  [
    `# ${entry.name}`,
    '',
    entry.summary,
    ...(entry.usage === undefined ? [] : ['', entry.usage]),
    '',
    `Mount it inside \`${namespace}.Root\`.`,
    '',
    '## Props',
    '',
    '| Prop | Type |',
    '| --- | --- |',
    ...Object.entries(entry.props).map(
      ([prop, type]) => `| \`${prop}\` | \`${type.replace(/\|/g, '\\|')}\` |`
    ),
    '',
  ].join('\n');

const propKey = (prop: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(prop) ? prop : `'${prop}'`;

const indexDts = (catalog: CatalogEntry[], namespace: string): string =>
  [
    "import type * as React from 'react';",
    '',
    ...catalog.flatMap((entry) => [
      `/** ${entry.summary} */`,
      `export interface ${entry.name}Props {`,
      ...Object.entries(entry.props).map(
        ([prop, type]) => `  ${propKey(prop)}?: ${type};`
      ),
      '  [prop: string]: unknown;',
      '}',
      `export declare const ${entry.name}: React.ComponentType<${entry.name}Props>;`,
      '',
    ]),
    'declare global {',
    '  interface Window {',
    `    ${namespace}: {`,
    ...catalog.map(({ name }) => `      ${name}: typeof ${name};`),
    '    };',
    '  }',
    '}',
    '',
  ].join('\n');

export const PHOTOS_ONLY_LINE =
  "Built from photos only: Lambda couldn't find this app's theme or components in the code.";

const readme = (input: AssembleInput): string => {
  const { namespace, bundle } = input;
  const hasScreens = input.screens.length > 0;

  return [
    ...(input.source === 'photos' ? [PHOTOS_ONLY_LINE, ''] : []),
    `# ${input.title}`,
    '',
    `${input.title}'s own look${
      bundle === undefined ? '' : ' and components'
    }, taken from its code, so a design drawn with them looks like the app.`,
    '',
    ...(hasScreens || input.sampleData !== undefined
      ? [
          '## Start here',
          '',
          ...(hasScreens
            ? [
                "1. **Copy the closest reference screen.** `screens/` holds the app's real pages redrawn from these components, one window each (1440×900, or 390×844 for a phone), with their situations switchable. Copy the one nearest your design and change only what your design's brief changes.",
                ...input.screens.map(
                  ({ file, title, route, summary, phone }) =>
                    `   - \`screens/${file}\` — ${title} (\`${route}\`${
                      phone === true ? ', phone' : ''
                    }): ${summary}`
                ),
              ]
            : []),
          ...(input.sampleData === undefined
            ? []
            : [
                `${
                  hasScreens ? '2' : '1'
                }. **Use the sample data.** \`sample-data.js\` sets \`window.${namespace}Sample\`. Load it after \`bundle.js\` and read people, places and amounts from it instead of making up your own, so every design shows the same data.`,
              ]),
          '',
        ]
      : []),
    '## Components',
    '',
    ...(bundle === undefined
      ? [input.noBundleReason ?? 'This design system has the look only.']
      : input.catalog.map(({ name, summary }) => `- \`${name}\` — ${summary}`)),
    '',
    '## Copied by hand',
    '',
    ...(input.patterns.length === 0
      ? ['Nothing: every component is the app’s own.']
      : input.patterns.map(
          ({ file, copies }) =>
            `- \`patterns/${file}\` copies ${copies
              .map((one) => `\`${one}\``)
              .join(', ')}`
        )),
    '',
    '## Left out',
    '',
    ...(input.leftOut.length === 0 && input.skipped.length === 0
      ? ['Nothing.']
      : [
          ...input.leftOut.map(({ name, why }) => `- \`${name}\`: ${why}`),
          ...input.skipped.map(
            ({ name, value, reason }) =>
              `- Token \`${name}\` (\`${value}\`): ${reason}.`
          ),
        ]),
    '',
    '## Consuming this system',
    '',
    ...(bundle === undefined
      ? [
          '- Use the tokens in `tokens.json` for colour, spacing and corners; there are no components to mount.',
        ]
      : [
          `- The bundle's global is \`window.${namespace}\`.`,
          '- Load `components/bundle.css`, then `components/bundle.js`. Skip React: the page provides React 18 as `window.React` and `window.ReactDOM`.',
          `- Wrap everything in \`${namespace}.Root\`; a component outside it renders without the app's theme.`,
        ]),
    '',
  ].join('\n');
};

/** The cover: the project's name over its first colours. */
const coverHtml = (title: string, tokens: TokensJson): string => {
  const swatches = tokens.color.tokens.slice(0, 4).map(({ name }) => name);

  return `<!-- @dsCard height=288 -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { font-family: system-ui, sans-serif; overflow: hidden; }
  .cover { position: relative; height: 288px; }
  .blocks { position: absolute; right: 24px; top: 24px; display: flex; gap: 16px; }
  .blocks div { width: 96px; height: 240px; border-radius: 8px; }
  .name { position: absolute; left: 24px; bottom: 24px; margin: 0; font-size: 64px; font-weight: 600; }
${swatches
  .map((name, index) => `  .b${index} { background: var(--${name}); }`)
  .join('\n')}
</style>
</head>
<body>
<div class="cover">
<div class="blocks" aria-hidden="true">${swatches
    .map((_, index) => `<div class="b${index}"></div>`)
    .join('')}</div>
<h1 class="name">${title}</h1>
</div>
</body>
</html>
`;
};

const designSystemJson = (input: AssembleInput): string =>
  `${JSON.stringify(
    {
      v: 3,
      layout: 'files',
      createdOnFiles: { v: 1, at: input.createdAt },
      title: input.title,
      namespace: input.namespace,
      libraries: [
        { name: 'react', version: '18' },
        { name: 'react-dom', version: '18' },
      ],
      sections: {},
      groups: [],
      assetGroups: {},
      blobs: {},
      docs: { sections: [] },
      lastChange: {
        by: 'lambda',
        at: input.at,
        via: `lambda design system · ${
          input.version === undefined ? '' : `v${input.version} · `
        }${input.sha}`,
        note: `Built from the project at ${input.sha}.`,
        sha: input.sha,
      },
    },
    null,
    2
  )}\n`;

/** `sample-data.js`: the sample data as `window.<N>Sample`. */
const sampleDataJs = (namespace: string, sampleData: unknown): string =>
  [
    `/* The sample data every design draws from (sampleData.ts). Load it after bundle.js. */`,
    `window.${namespace}Sample = ${inlineJson(sampleData)};`,
    '',
  ].join('\n');

/** A catalog name: it becomes a folder, a type and a namespace key. */
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Every file of the system, keyed by its path. Throws on a bundle that
 * breaks a rule, a catalog entry whose name isn't a component name, or a
 * screen the index lists that has no file.
 */
export const assembleSystem = (
  input: AssembleInput
): { files: Record<string, string>; warnings: string[] } => {
  const { namespace, bundle } = input;
  const badName = input.catalog.find(({ name }) => !COMPONENT_NAME.test(name));

  if (badName !== undefined) {
    throw new Error(
      `catalog.ts lists ${JSON.stringify(
        badName.name
      )}, which is not a component name (${COMPONENT_NAME}).`
    );
  }

  const warnings =
    bundle === undefined ? [] : checkBundle(bundle.js, namespace);

  const screens = Object.fromEntries(
    input.screens.map(({ file }) => {
      const body = input.screenFiles[file];

      if (body === undefined) {
        throw new Error(
          `screens/index.ts lists ${file}, but screens/ has no such file.`
        );
      }

      return [`${SCREENS_DIR}/${file}`, body];
    })
  );

  return {
    warnings,
    files: {
      [README]: readme(input),
      [TOKENS]: `${JSON.stringify(input.tokens, null, 2)}\n`,
      ...(bundle === undefined
        ? {}
        : {
            [BUNDLE_JS]: bundle.js,
            [BUNDLE_CSS]: bundle.css,
            'project/components/index.d.ts': indexDts(input.catalog, namespace),
            ...Object.fromEntries(
              input.catalog.flatMap((entry) => [
                [
                  `project/components/${entry.name}/README.md`,
                  componentReadme(entry, namespace),
                ],
                [
                  `project/components/${entry.name}/preview.html`,
                  previewHtml(entry, namespace),
                ],
              ])
            ),
            'project/components/Cover/preview.html': coverHtml(
              input.title,
              input.tokens
            ),
          }),
      ...(input.sampleData === undefined
        ? {}
        : { [SAMPLE_DATA_FILE]: sampleDataJs(namespace, input.sampleData) }),
      ...screens,
      // The index goes last (the type writes it last).
      [INDEX]: designSystemJson(input),
    },
  };
};
