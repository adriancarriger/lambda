import * as fs from 'fs';
import * as path from 'path';
import { type Page } from 'playwright';

import { withArtboard } from '../render';
import { type CatalogEntry, inlineJson } from './assemble';
import { type Metafile } from './bundle';
import { readyRelease, writeCheckCanvas } from './checkCanvas';
import { matchesAny } from './glob';
import { installSystem } from './install';

/**
 * `lambda design system build --check`'s two checks, used by the setup
 * ticket and the build's design check (never by planning). Each reports
 * every problem, naming the component, without changing the source: the
 * setup fixes a piece by copying it as a pattern or leaving it out.
 */

/**
 * Data, search, auth, analytics, checkout, monitoring and feature-flag SDKs: app
 * runtime that must stay off a canvas. Alphabetical, ignoring a leading `@`.
 */
export const APP_RUNTIME_PACKAGES = [
  '@adyen/',
  'algoliasearch',
  '@amplitude/',
  '@apollo/client',
  'appwrite',
  '@auth0/',
  '@aws-amplify/',
  '@azure/msal-browser',
  'braintree-web',
  '@bugsnag/',
  '@clerk/',
  'convex',
  '@datadog/',
  'firebase',
  '@fullstory/',
  'heap-api',
  '@honeybadger-io/',
  '@hotjar/',
  'keycloak-js',
  '@kinde-oss/',
  'launchdarkly-js-client-sdk',
  '@lemonsqueezy/',
  'logrocket',
  'mixpanel',
  'newrelic',
  'next-auth',
  'oidc-client-ts',
  '@okta/',
  '@paddle/',
  '@paypal/',
  'plausible-tracker',
  'pocketbase',
  'posthog-js',
  '@prisma/client',
  'react-ga4',
  'rollbar',
  '@segment/',
  '@sentry/',
  'stripe',
  '@supabase/',
  '@tanstack/react-query',
  '@trpc/',
  'urql',
  '@vercel/analytics',
  '@workos-inc/',
];

/** The package an input belongs to: its last `node_modules/<name>`. */
const packageOf = (input: string): string | undefined => {
  const all = Array.from(
    input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g),
    (match) => match[1] ?? ''
  );

  return all.at(-1);
};

const runtimeLabel = (input: string, exclude: string[]): string | undefined => {
  const name = packageOf(input);

  if (name !== undefined) {
    // A plain name also covers its siblings (`mixpanel-browser`) and its own
    // scope (`@<name>/js`); a scope (`@okta/`) covers every package in it.
    const listed = APP_RUNTIME_PACKAGES.find((one) =>
      one.endsWith('/')
        ? name.startsWith(one)
        : name === one ||
          name.startsWith(`${one}-`) ||
          name.startsWith(`@${one}/`)
    );

    if (listed !== undefined) {
      return listed === name ? listed : name;
    }
  }

  return matchesAny(exclude, input) ? input : undefined;
};

/**
 * The names an entry binds for each import specifier. A clause never crosses
 * a `;` or another `import`/`export`, so one statement can't swallow the next.
 */
const namesBySpecifier = (entryText: string): Map<string, string[]> => {
  const statements = Array.from(
    entryText.matchAll(
      /\b(import|export)\s+(?:type\s+)?((?:(?!\b(?:import|export)\b)[^;])*?)\s+from\s+['"]([^'"]+)['"]/g
    )
  );

  return statements.reduce((map, match) => {
    const [, kind] = match;
    const clause = match[2] ?? '';
    const specifier = match[3] ?? '';
    const braced = /\{([\s\S]*)\}/.exec(clause)?.[1];
    const named = (braced ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !part.startsWith('type '))
      .map((part) => {
        const [imported, local] = part.split(/\s+as\s+/);

        return (
          (kind === 'export' ? local ?? imported : local ?? imported) ?? ''
        );
      });
    const plain = clause
      .replace(/\{[\s\S]*\}/, '')
      .split(',')
      .map((part) => part.replace(/^\*\s+as\s+/, '').trim())
      .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
    const names = [...plain, ...named].filter((name) => name !== '');

    return new Map(map).set(specifier, [
      ...(map.get(specifier) ?? []),
      ...names,
    ]);
  }, new Map<string, string[]>());
};

/**
 * Every input reachable from `start`, `start` included: one Set, walked as it
 * grows (a Set's iterator visits what is added during the walk), no recursion.
 */
const reachable = (metafile: Metafile, start: string): Set<string> => {
  const seen = new Set<string>([start]);

  for (const input of seen) {
    (metafile.inputs[input]?.imports ?? [])
      .filter((one) => one.external !== true)
      .forEach((one) => seen.add(one.path));
  }

  return seen;
};

/**
 * "<Name> loads <package>." for every component whose import, walked from
 * the entry, reaches app runtime (or a `design.systemBuild.exclude` file).
 */
export const appRuntimeProblems = ({
  metafile,
  entry,
  entryText,
  exclude,
}: {
  metafile: Metafile;
  /** The entry as the metafile names it (relative to the checkout). */
  entry: string;
  entryText: string;
  exclude: string[];
}): string[] => {
  if (metafile.inputs[entry] === undefined) {
    // The project's own build named its inputs from elsewhere: no import can
    // be tied to a component, so name what the bundle loads at all.
    const loads = Object.keys(metafile.inputs).flatMap((input) => {
      const label = runtimeLabel(input, exclude);

      return label === undefined ? [] : [label];
    });

    return Array.from(new Set(loads)).map(
      (label) => `${entry} loads ${label}.`
    );
  }

  const names = namesBySpecifier(entryText);
  const direct = (metafile.inputs[entry]?.imports ?? []).filter(
    (one): one is { path: string; original?: string } => one.external !== true
  );

  return Array.from(
    new Set(
      direct.flatMap((one) => {
        const original =
          'original' in one && typeof one.original === 'string'
            ? one.original
            : '';
        const loads = Array.from(reachable(metafile, one.path)).flatMap(
          (input) => {
            const label = runtimeLabel(input, exclude);

            return label === undefined ? [] : [label];
          }
        );
        const named = names.get(original) ?? [];
        // `export * from` binds no name: the file's own stands in.
        const bound =
          named.length > 0
            ? named
            : [path.basename(one.path, path.extname(one.path))];

        return Array.from(new Set(loads)).flatMap((label) =>
          bound.map((name) => `${name} loads ${label}.`)
        );
      })
    )
  );
};

/** The artboard that draws one component as its preview does. */
export const drawArtboard = (
  entry: CatalogEntry,
  namespace: string
): string => {
  const ds = `ds/${namespace.toLowerCase()}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${entry.name} — draw check</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="${ds}/components/bundle.css">
<script src="${ds}/components/bundle.js"></script>
</head>
<body>
<x-dc><div id="draw" style="display: inline-block; min-width: 1px;"></div></x-dc>
<script>
  (function () {
    var example = ${inlineJson(entry.example)};
    var rootProps = ${inlineJson(entry.rootProps ?? {})};
    function isNode(value) {
      return value !== null && typeof value === 'object' && typeof value.component === 'string';
    }
    function mount(target) {
      var N = window.${namespace}, h = window.React.createElement;
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
        var type = /^[a-z]/.test(node.component) ? node.component : N[node.component];
        return h.apply(null, [type, resolve(node.props || {})].concat((node.children || []).map(build)));
      }
      window.ReactDOM.createRoot(target).render(h(N.Root, rootProps, build(example)));
    }
    function wait() {
      var target = document.querySelector('#dc-root #draw');
      if (target === null) { requestAnimationFrame(wait); return; }
      mount(target);
    }
    wait();
  })();
</script>
</body>
</html>
`;
};

const DRAW_WINDOW = { w: 1200, h: 800 };

// How many pixels of a transparent-background PNG (base64) are not fully
// transparent, decoded in the page so no PNG reader is needed here.
const OPAQUE_PIXELS = `async (png) => {
  const image = new Image();
  image.src = 'data:image/png;base64,' + png;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let opaque = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if (data[alpha] !== 0) opaque += 1;
  }
  return opaque;
}`;

/**
 * Whether the component painted anything anywhere in the window: a fully
 * transparent picture is nothing. The whole window, not just the draw
 * target, since a dialog or menu draws into a portal on document.body.
 */
const drewSomething = async (page: Page): Promise<boolean> => {
  const png = await page.screenshot({ omitBackground: true });
  const opaque: unknown = await page.evaluate(
    `(${OPAQUE_PIXELS})(${JSON.stringify(png.toString('base64'))})`
  );

  return typeof opaque === 'number' && opaque > 0;
};

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .split('\n')[0]
    ?.replace(/^The artboard threw: /, '')
    .replace(/^The artboard runtime reported: /, '') ?? '';

/**
 * Draw every catalog entry on the check canvas
 * (`<checkout>/.lambda/design/_system-check/canvas/`), each through its own
 * `_draw-<Name>.dc.html` artboard, and name each that throws, draws nothing
 * or reaches outside the local server.
 */
export const drawCheckProblems = async ({
  builtDir,
  checkout,
  catalog,
  namespace,
  log = () => {},
}: {
  builtDir: string;
  checkout: string;
  catalog: CatalogEntry[];
  namespace: string;
  log?: (line: string) => void;
}): Promise<string[]> => {
  const canvasDir = path.join(
    checkout,
    '.lambda',
    'design',
    '_system-check',
    'canvas'
  );
  fs.rmSync(canvasDir, { recursive: true, force: true });
  installSystem({ builtDir, canvasDir, namespace });
  const boards = catalog.map(({ name }) => ({
    file: `_draw-${name}.dc.html`,
    ...DRAW_WINDOW,
  }));
  writeCheckCanvas({
    canvasDir,
    release: readyRelease("the design system's components can't be drawn"),
    boards,
  });
  catalog.forEach((entry, index) =>
    fs.writeFileSync(
      path.join(canvasDir, 'project', boards[index]?.file ?? ''),
      drawArtboard(entry, namespace)
    )
  );

  return catalog.reduce<Promise<string[]>>(async (found, entry, index) => {
    const done = await found;
    const board = boards[index]?.file ?? '';
    const problem = await withArtboard(
      { canvasDir, artboard: board, log, readyTimeoutMs: 10_000 },
      async ({ open, blocked }) => {
        // A blocked request usually fails the component too: name the
        // request, which is the cause, before any error it led to.
        const reachedOut = (): string | null => {
          const [first] = blocked();

          return first === undefined
            ? null
            : `${entry.name} reached ${new URL(first).hostname}.`;
        };

        try {
          const loaded = await open();
          await loaded.settle();
          const drawn = await drewSomething(loaded.page);

          return (
            reachedOut() ??
            (drawn ? null : `${entry.name} failed to draw: nothing drawn`)
          );
        } catch (error) {
          return (
            reachedOut() ?? `${entry.name} failed to draw: ${firstLine(error)}`
          );
        }
      }
    ).catch(
      (error: unknown) => `${entry.name} failed to draw: ${firstLine(error)}`
    );

    return problem === null ? done : [...done, problem];
  }, Promise.resolve([]));
};
