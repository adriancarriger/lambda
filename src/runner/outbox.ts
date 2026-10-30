import * as fs from 'fs';
import * as path from 'path';

import type { Message } from '../protocol';

/**
 * `~/.lambda/outbox.jsonl`: what a runner sends the mothership (pod state,
 * events), in order. Every item has an id; it stays until the mothership
 * acknowledges that id, so a runner that was offline (or crashed) sends
 * whatever hasn't arrived, in order, once it reconnects. The mothership
 * ignores ids it already stored, so a resend never counts twice.
 *
 * The file is a log, only ever appended to: an item line, or a `{"drop":
 * id}` line for an item acknowledged or replaced by a newer state. What is
 * pending is kept in memory; the file is rewritten (compacted) only once
 * the dropped lines outnumber the pending ones, so a state push every few
 * seconds costs one appended line, not a rewrite.
 */

export interface OutboxItem extends Message {
  id: string;
}

export interface Outbox {
  /** Keep an item; `replaces` drops a still-unsent item it supersedes. */
  add: (item: OutboxItem, replaces?: (other: OutboxItem) => boolean) => void;
  /** Everything not yet acknowledged, oldest first. */
  pending: () => OutboxItem[];
  /** The mothership stored it: drop it. */
  ack: (id: string) => void;
}

/** Compact once this many lines are dead weight, and they outnumber the rest. */
const COMPACT_AFTER = 50;

const isDrop = (value: unknown): value is { drop: string } =>
  typeof value === 'object' &&
  value !== null &&
  'drop' in value &&
  typeof value.drop === 'string';

const isItem = (value: unknown): value is OutboxItem =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'type' in value &&
  typeof value.type === 'string';

export const createOutbox = (
  file: string,
  log: (line: string) => void = (line) => console.error(line)
): Outbox => {
  const state: { items: OutboxItem[] | null; dead: number } = {
    items: null,
    dead: 0,
  };

  const readText = (): string => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      // Not `instanceof Error`: fs errors can come from another realm.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return '';
      }

      throw error;
    }
  };

  const append = (lines: unknown[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      file,
      lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      { mode: 0o600 }
    );
  };

  /** Replay the log once; later calls answer from memory. */
  const items = (): OutboxItem[] => {
    if (state.items !== null) {
      return state.items;
    }

    const text = readText();
    const replayed = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .reduce<{ items: OutboxItem[]; dead: number }>(
        (so, line) => {
          const parsed: unknown = (() => {
            try {
              return JSON.parse(line);
            } catch {
              return undefined;
            }
          })();

          if (isDrop(parsed)) {
            return {
              items: so.items.filter((item) => item.id !== parsed.drop),
              dead: so.dead + 2,
            };
          }

          if (isItem(parsed)) {
            return { ...so, items: [...so.items, parsed] };
          }

          log(`Skipping a damaged line in ${file}: ${line}`);

          return { ...so, dead: so.dead + 1 };
        },
        { items: [], dead: 0 }
      );

    // A crash mid-append left half a line: the next one starts on its own.
    if (text !== '' && !text.endsWith('\n')) {
      fs.appendFileSync(file, '\n');
    }

    state.items = replayed.items;
    state.dead = replayed.dead;

    return state.items;
  };

  const compact = (): void => {
    const live = items();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp`;
    fs.writeFileSync(
      temp,
      live.map((item) => `${JSON.stringify(item)}\n`).join(''),
      { mode: 0o600 }
    );
    fs.renameSync(temp, file);
    state.dead = 0;
  };

  /** Drop `ids` and keep `added`, as one append; compact when it's worth it. */
  const change = (ids: string[], added: OutboxItem[]): void => {
    const gone = new Set(ids);
    state.items = [...items().filter((item) => !gone.has(item.id)), ...added];
    append([...ids.map((id) => ({ drop: id })), ...added]);
    state.dead += ids.length * 2;

    if (state.dead > COMPACT_AFTER && state.dead > state.items.length) {
      compact();
    }
  };

  return {
    add: (item, replaces) =>
      change(
        replaces === undefined
          ? []
          : items()
              .filter((other) => replaces(other))
              .map((other) => other.id),
        [item]
      ),
    pending: () => [...items()],
    ack: (id) => {
      if (items().some((item) => item.id === id)) {
        change([id], []);
      }
    },
  };
};
