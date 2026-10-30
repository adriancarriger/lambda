import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ChunkBoundary,
  CrashedNotice,
  UpdatedNotice,
  isChunkLoadError,
} from '../client/ChunkBoundary';
import * as uiLogModule from '../client/uiLog';

describe('a screen whose chunk fails to load', () => {
  it('turns a failed import into the updated notice', () => {
    // What each browser says when a rebuilt client's old chunk is gone.
    [
      'Failed to fetch dynamically imported module: http://127.0.0.1:4580/assets/AnalyticsPage-3f9a.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
    ].forEach((message) => {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
      expect(
        ChunkBoundary.getDerivedStateFromError(new TypeError(message))
      ).toEqual({ failed: 'chunk' });
    });
  });

  it('calls any other error a crash, not an update', () => {
    const crash = new TypeError(
      "Cannot read properties of undefined (reading 'name')"
    );

    expect(isChunkLoadError(crash)).toBe(false);
    expect(ChunkBoundary.getDerivedStateFromError(crash)).toEqual({
      failed: 'crash',
    });
    expect(isChunkLoadError('not an error')).toBe(false);
  });

  it('says Lambda was updated and offers a reload', () => {
    const html = renderToStaticMarkup(createElement(UpdatedNotice));

    expect(html).toContain('Lambda was updated. Reload.');
    expect(html).toContain('<button');
  });

  it('says a crash went wrong, and offers a reload', () => {
    const html = renderToStaticMarkup(createElement(CrashedNotice));

    expect(html).toContain('Something went wrong on this screen. Reload.');
    expect(html).toContain('<button');
  });

  it('logs what failed, so it reaches the page’s trail', () => {
    const log = jest
      .spyOn(uiLogModule, 'uiLog')
      .mockImplementation(() => undefined);
    const boundary = new ChunkBoundary({ children: null });

    boundary.componentDidCatch(new Error('row.name is undefined'), {
      componentStack: '\n    at AnalyticsPage',
    });

    expect(log).toHaveBeenCalledWith('js-error', {
      message: 'row.name is undefined',
      where: 'at AnalyticsPage',
    });
    log.mockRestore();
  });

  it('tries the screen again once another page is opened', () => {
    const boundary = new ChunkBoundary({
      children: null,
      resetKey: 'analytics',
    });
    boundary.state = { failed: 'crash' };
    const setState = jest
      .spyOn(boundary, 'setState')
      .mockImplementation(() => undefined);

    boundary.componentDidUpdate({ resetKey: 'analytics' });
    expect(setState).not.toHaveBeenCalled();

    Object.assign(boundary, {
      props: { children: null, resetKey: 'computers' },
    });
    boundary.componentDidUpdate({ resetKey: 'analytics' });
    expect(setState).toHaveBeenCalledWith({ failed: null });
  });

  it('renders its children while nothing failed', () => {
    const html = renderToStaticMarkup(
      createElement(ChunkBoundary, null, createElement('p', null, 'Pawnee'))
    );

    expect(html).toBe('<p>Pawnee</p>');
  });
});

describe('the pod screen’s lazy panels', () => {
  /** Each `<Lazy …>` opening tag in App, with the component inside it. */
  const lazyTags = (): { tag: string; inside: string }[] =>
    Array.from(
      fs
        .readFileSync(path.join(__dirname, '..', 'client', 'App.tsx'), 'utf8')
        .matchAll(/<Lazy\b([^>]*)>\s*<(\w+)/g),
      (match) => ({ tag: match[1] ?? '', inside: match[2] ?? '' })
    );

  it('try again when another pod opens, not only on a reload', () => {
    const panels = ['ChatPanel', 'WorkflowPanel', 'WindowPicker', 'MadeRail'];
    const tags = lazyTags().filter(({ inside }) => panels.includes(inside));

    expect(tags.map(({ inside }) => inside).sort()).toEqual([...panels].sort());
    tags.forEach(({ tag, inside }) =>
      expect({ inside, tag }).toEqual({
        inside,
        tag: expect.stringContaining('resetKey={detailPodId'),
      })
    );
  });
});
