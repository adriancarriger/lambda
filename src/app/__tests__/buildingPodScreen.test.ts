import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ThreadMessage } from '../../pod-store';
import {
  ChatLine,
  VisualPairViewer,
  VisualPairs,
} from '../client/BuildingPodScreen';
import type {
  VisualIssueView,
  VisualPictureView,
  VisualRoundView,
} from '../shared/building';

/**
 * A building pod's chat lines. react-markdown is ESM-only, which jest can't
 * load, so Markdown is a stand-in that shows what it was given; the terminal
 * pulls in xterm's CSS.
 */
jest.mock('../client/Message', () => ({
  Markdown: ({ text }: { text: string }) =>
    jest
      .requireActual<typeof import('react')>('react')
      .createElement('div', { className: 'md', 'data-markdown': text }),
}));
jest.mock('../client/TerminalView', () => ({ TerminalView: () => null }));

const BLOCKED = [
  '**What:** Upload park photos to the shared album',
  '**Problem:** The photo storage key is missing',
  '**Options:** 1) add the key  2) skip photos for now',
  '**Recommendation:** add the key; this Lambda moved on',
].join('\n');

const message = (extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: 'm1',
  podId: 'build-a1b2',
  from: 'engineering-manager',
  mode: 'note',
  text: BLOCKED,
  createdAt: '2026-10-23T10:00:00.000Z',
  delivery: 'delivered',
  ...extra,
});

const render = (props: Parameters<typeof ChatLine>[0]): string =>
  renderToStaticMarkup(createElement(ChatLine, props));

describe("an Engineering manager's bubble", () => {
  it('renders its text as Markdown, credited to Lambda whatever its role', () => {
    const html = render({ message: message() });

    expect(html).toContain('class="build-bubble"');
    expect(html).toContain('<strong>Lambda:</strong>');
    expect(html).not.toContain('Engineering manager');
    expect(html).toContain(`data-markdown="${BLOCKED}"`);
  });

  it('has an answer box when it is an item waiting on the owner', () => {
    const html = render({ message: message(), onAnswer: async () => {} });

    expect(html).toContain('<textarea');
    expect(html).toContain('Answer this item…');
  });

  it('has no answer box when nothing waits on it', () => {
    expect(render({ message: message() })).not.toContain('<textarea');
  });

  it("shows a visual check's pictures on its Blocked item", () => {
    const html = render({
      message: message({
        pictures: ['composite-trail-closed.png'],
        picturesAt: { ticketId: 'PAWNEE-5', round: 7 },
      }),
    });

    expect(html).toContain('class="build-bubble__pictures"');
    expect(html).toContain(
      'src="/api/pod/build-a1b2/visual/PAWNEE-5/7/composite-trail-closed.png"'
    );
  });
});

describe("the Visual check row's pictures", () => {
  const picture = (issues: VisualIssueView[]): VisualPictureView => ({
    scenarioId: 'trail-closed',
    situation: 'Trail map — Trail closed',
    expected: 'expected-trail-closed.png',
    actual: 'actual-trail-closed.png',
    issues,
  });
  const medium: VisualIssueView = {
    severity: 'medium',
    where: 'Legend',
    what: 'below the map, should be beside it',
  };
  const round = (issues: VisualIssueView[]): VisualRoundView => ({
    round: 2,
    at: '2026-10-23T10:00:00.000Z',
    pictures: [picture(issues)],
  });

  it('opens a pair full size with its round and its issues', () => {
    const open = round([medium]);
    const html = renderToStaticMarkup(
      createElement(VisualPairViewer, {
        podId: 'build-a1b2',
        open: {
          ticketId: 'PAWNEE-5',
          round: open,
          picture: picture([medium]),
        },
        onClose: () => undefined,
      })
    );

    expect(html).toContain(
      'Visual check · round 2 · Trail map — Trail closed'
    );
    expect(html).toContain(
      'src="/api/pod/build-a1b2/visual/PAWNEE-5/2/expected-trail-closed.png"'
    );
    expect(html).toContain(
      'src="/api/pod/build-a1b2/visual/PAWNEE-5/2/actual-trail-closed.png"'
    );
    expect(html).toContain(
      '<li>Medium · Legend: below the map, should be beside it</li>'
    );
  });

  it('names a thumbnail by its picture, saying when it has issues, not by its ✗', () => {
    const pairs = (issues: VisualIssueView[]) =>
      renderToStaticMarkup(
        createElement(VisualPairs, {
          podId: 'build-a1b2',
          ticketId: 'PAWNEE-5',
          rounds: [round(issues)],
          onPair: () => undefined,
        })
      );

    expect(pairs([medium])).toContain(
      'aria-label="Round 2 · Trail map — Trail closed · has issues"'
    );
    expect(pairs([medium])).toContain(
      '<span class="build-shot__fail" aria-hidden="true">✗</span>'
    );
    expect(pairs([])).toContain(
      'aria-label="Round 2 · Trail map — Trail closed"'
    );
  });
});

describe('the Workflow rail styles', () => {
  // The rail marks a skipped step `build-step--skipped`; without a rule it
  // reads as done apart from its "–".
  it('mutes a skipped step like one still to come', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'client', 'styles.css'),
      'utf8'
    );

    expect(css).toMatch(/\.build-step--skipped \{\s*color: var\(--grey-500\);/);
  });
});
