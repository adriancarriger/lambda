import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  madeHere,
  prototypeFilePath,
  prototypeHeaders,
  withBridge,
} from '../server/prototypes';
import {
  messageShows,
  pictureOnPrototype,
  podFileOf,
  splitPrototypeLines,
} from '../shared/prototypes';
import { speakable } from '../shared/speech';

/**
 * Lambda's prototypes in the inbox (2026-10-20): the lines that put a
 * card in the chat, the sandboxed files the focus view frames, and the Made
 * here listing.
 */

const POD = 'pawnee-home-a1b2';

const manifest = (version: number, createdAt: string) => ({
  slug: 'home',
  version,
  title: 'Home page directions',
  createdAt,
  hash: `h${version}`,
  situations: [{ slug: 'busy', title: 'Busy afternoon' }],
  boards: [
    {
      file: 'Desk.dc.html',
      letter: 'C',
      title: 'Your desk',
      w: 1440,
      h: 1240,
      stills: { busy: `designs/home/prototype/v${version}/stills/C/busy.png` },
    },
  ],
});

const seed = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pods-proto-'))
  );
  const write = (rel: string, body: string): void => {
    const file = path.join(root, POD, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  [1, 2].forEach((version) => {
    const dir = `designs/home/prototype/v${version}`;
    write(
      `${dir}/files/Desk.dc.html`,
      '<html><body><x-dc></x-dc></body></html>'
    );
    write(`${dir}/files/support.js`, '//');
    write(`${dir}/stills/C/busy.png`, 'png');
    write(
      `${dir}/prototype.json`,
      JSON.stringify(manifest(version, `2026-10-20T1${version}:00:00Z`))
    );
  });
  write('designs/home/prototype/v2/files/notes.md', 'not served');
  write('designs/home/C/busy.png', 'png');
  write('designs/home/walk/round-1/busy.png', 'draft');
  write('shots/home-desktop.png', 'png');
  write('thread.jsonl', '{}');
  fs.writeFileSync(path.join(root, 'outside.js'), '//');
  fs.symlinkSync(
    path.join(root, 'outside.js'),
    path.join(root, POD, 'designs/home/prototype/v1/files/escape.js')
  );

  return root;
};

describe('prototypeFilePath', () => {
  it("serves a version's files", () => {
    const root = seed();

    expect(prototypeFilePath(root, `${POD}/home/v2/Desk.dc.html`)).toBe(
      path.join(root, POD, 'designs/home/prototype/v2/files/Desk.dc.html')
    );
  });

  it.each([
    `${POD}/home/v2/notes.md`,
    `${POD}/home/v1/escape.js`,
    `${POD}/home/v2/../../../../thread.jsonl`,
    `${POD}/home/v2/%2e%2e/prototype.json`,
    `${POD}/home/v0/Desk.dc.html`,
    `${POD}/home/v3/Desk.dc.html`,
    `${POD}/Home/v2/Desk.dc.html`,
    `Pawnee!/home/v2/Desk.dc.html`,
    `${POD}/home/v2`,
  ])('refuses %s', (rest) => {
    expect(prototypeFilePath(seed(), rest)).toBeNull();
  });

  // e.g. `files -> ~/.lambda`, which would serve the machine config.
  it.each([
    ['files', 'designs/home/prototype/v3/files', 'secret'],
    ['version', 'designs/home/prototype/v3', 'secret-v3'],
  ])('refuses a %s folder that is a symlink', (_, link, target) => {
    const root = seed();
    const secret = path.join(root, 'secret-v3/files/config.json');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, '{}');
    fs.mkdirSync(path.dirname(path.join(root, POD, link)), { recursive: true });
    fs.symlinkSync(
      path.join(root, target === 'secret' ? 'secret-v3/files' : target),
      path.join(root, POD, link)
    );

    expect(prototypeFilePath(root, `${POD}/home/v3/config.json`)).toBeNull();
  });
});

describe('prototypeHeaders', () => {
  it('forbids fetching and forms, and names the inbox as it was reached', () => {
    const csp =
      prototypeHeaders(
        'Desk.dc.html',
        'lambda.tail1234.ts.net',
        `/proto/${POD}/home/v2/`
      )['content-security-policy'] ?? '';

    // Its own folder only: the runtime reads its artboard back, nothing else.
    expect(csp).toContain(
      `connect-src http://lambda.tail1234.ts.net/proto/${POD}/home/v2/ https://lambda.tail1234.ts.net/proto/${POD}/home/v2/;`
    );
    expect(csp).toContain("form-action 'none'");
    // Its own tab is sandboxed too, never the inbox's origin.
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain(
      "frame-ancestors 'self' http://lambda.tail1234.ts.net https://lambda.tail1234.ts.net"
    );
  });

  it('ignores a host header it cannot trust', () => {
    expect(
      prototypeHeaders(
        'a.js',
        'evil.com; script-src *',
        `/proto/${POD}/home/v2/`
      )['content-security-policy']
    ).not.toContain('evil.com');
  });
});

describe('withBridge', () => {
  it("adds the bridge at the end of the artboard's body", () => {
    const html = withBridge('<html><body><x-dc></x-dc></body></html>');

    expect(html).toMatch(/<\/x-dc><script>\(function \(\) \{/);
    expect(html.endsWith('</script></body></html>')).toBe(true);
  });
});

describe('madeHere', () => {
  it('lists every version, newest first, and the pictures without drafts or stills', () => {
    const made = madeHere(seed(), POD);

    expect(made?.prototypes.map((group) => group.slug)).toEqual(['home']);
    expect(made?.prototypes[0]?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(made?.pictures.map((picture) => picture.path).sort()).toEqual([
      'designs/home/C/busy.png',
      'shots/home-desktop.png',
    ]);
  });

  it('refuses a pod id it would never name', () => {
    expect(madeHere(seed(), '../etc')).toBeNull();
  });
});

describe('the chat lines', () => {
  it("reads a Lambda message's prototype cards", () => {
    expect(
      splitPrototypeLines(
        'Three directions.\n[Prototype: home v3]\nTry C first.'
      )
    ).toEqual({
      text: 'Three directions.\nTry C first.',
      prototypes: [{ slug: 'home', version: 3 }],
    });
  });

  it('is never read aloud', () => {
    expect(speakable('Here they are.\n[Prototype: home v3]\nTry C.')).toBe(
      'Here they are.\nTry C.'
    );
  });

  it('knows which message sent a version or a picture', () => {
    expect(
      messageShows('x\n[Prototype: home v3]', {
        prototype: { slug: 'home', version: 3 },
      })
    ).toBe(true);
    expect(
      messageShows('x\n[Prototype: home v3]', {
        prototype: { slug: 'home', version: 2 },
      })
    ).toBe(false);
    expect(
      messageShows(`![C](/home/leslie/.pods/${POD}/designs/home/C/busy.png)`, {
        picture: 'designs/home/C/busy.png',
      })
    ).toBe(true);
  });
});

describe('pictures', () => {
  it('finds the board and situation a picture shows', () => {
    expect(pictureOnPrototype('designs/home/C/busy.png')).toEqual({
      slug: 'home',
      letter: 'C',
      situation: 'busy',
    });
    expect(pictureOnPrototype('designs/map/offline.png')).toEqual({
      slug: 'map',
      letter: null,
      situation: 'offline',
    });
    expect(pictureOnPrototype('shots/home.png')).toBeNull();
  });

  it("reads a pod's picture back from where the inbox serves it", () => {
    expect(podFileOf(`/api/pod-file/${POD}/designs/home/C/busy.png`)).toEqual({
      podId: POD,
      path: 'designs/home/C/busy.png',
    });
    expect(podFileOf('/api/uploads/img_1_a.png')).toBeNull();
  });
});
