import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { Question, ThreadMessage } from '../../pod-store';
import { splitImages, withWords, wordsOf } from '../shared/images';
import { itemTitle } from '../shared/items';
import { useImageDrop } from './ImageDrop';
import { Message } from './Message';
import { SpeakerIcon } from './SpeakerIcon';
import { type ChatTrack, chatTracks } from './chatPlaylist';

/**
 * The chat, always in the center: the pod's whole conversation with the owner
 * (every message they sent it, every message it sent them — answers on items
 * and chat alike), grouped by what it was about, and one box. It talks to the
 * pod's dev directly, as Claude Code does: ⏎ says something and nothing moves
 * on; ⌘⏎ is "done with the item that's up" (App decides what that means —
 * answer, approve, carry on). The Plan rail has the same Done as a button.
 */

/** What the old side chat's hand-off put in front of an answer. */
const DECIDED_PREFIX = 'Decided in the Chat panel:';

const isAgent = (message: ThreadMessage): boolean =>
  message.from === 'dev' ||
  message.from === 'manager' ||
  message.from === 'fork';

/** The owner ⇄ the pod — not agent-to-agent traffic or bookkeeping notes. */
const chatHistory = (thread: ThreadMessage[]): ThreadMessage[] =>
  thread.filter(
    (message) =>
      message.text !== '(warm-up)' &&
      ((message.from === 'human' && message.text.trim() !== '') ||
        (isAgent(message) && message.target === undefined) ||
        (message.from === 'system' &&
          message.text.startsWith('Sent the dev what you said in the chat')))
  );

/**
 * The quiet note under a message. Who speaks goes without saying, as in
 * Claude Code (your messages are the bubbles; every agent is Lambda), and the
 * "About …" line above a group says which item it's on; what's left is a
 * progress update.
 */
const noteOf = (message: ThreadMessage): string | undefined => {
  const parts = [message.progress === true ? 'Progress' : ''].filter(
    (part) => part !== ''
  );

  return parts.length === 0 ? undefined : parts.join(' · ');
};

export interface PendingChat {
  id: string;
  /** The pod it was sent to — the panel only shows its own pod's. */
  podId: string;
  about: string | null;
  text: string;
  at: number;
  /** The send failed (e.g. the app restarted): kept, with a retry. */
  failed?: boolean;
  /** Sent with ⌘⏎: the pod steps aside until the chat replies. */
  hold?: boolean;
}

export const ChatPanel = ({
  podLabel,
  thread,
  questions,
  pending,
  draft,
  onDraftChange,
  onSend,
  onDone,
  onRetry,
  context,
  whileWaiting,
  listening,
  onListen,
}: {
  podLabel: string;
  thread: ThreadMessage[];
  questions: Question[];
  /** Sent from this page, not in the thread yet. */
  pending: PendingChat[];
  /** The box's text — App keeps it (per item), so the Plan rail's Done sees it. */
  draft: string;
  onDraftChange: (text: string) => void;
  /** ⏎: say it to the dev; nothing moves on. */
  onSend: (text: string) => void;
  /** ⌘⏎: done with the item that's up (the text, if any, is the last word). */
  onDone: (text: string) => void;
  /** Re-send a message whose send failed. */
  onRetry: (sent: PendingChat) => void;
  /** A quiet line under the box (the dev is mid-turn), when there's one. */
  context?: ReactNode;
  /** Under the thinking dots: the offer to move on while Lambda works. */
  whileWaiting?: ReactNode;
  /** The message the chat playlist is on, if it's playing. */
  listening: { msgId: string; loading: boolean } | null;
  /** Speaker: play from this message through the newest (again: stop). */
  onListen: (msgId: string, tracks: () => ChatTrack[]) => void;
}) => {
  // The whole chat takes a dropped image, not just the box at the bottom.
  const drop = useImageDrop(draft, onDraftChange);
  const box = useRef<HTMLTextAreaElement>(null);
  const imageCount = splitImages(draft).images.length;
  const lastImageCount = useRef(imageCount);

  // An image just landed in the draft: the box takes focus, ready for words.
  useEffect(() => {
    if (imageCount > lastImageCount.current) {
      box.current?.focus();
    }

    lastImageCount.current = imageCount;
  }, [imageCount]);

  const topicLabel = (qid: string | undefined | null): string => {
    const question =
      qid === undefined || qid === null
        ? undefined
        : questions.find((candidate) => candidate.id === qid);

    if (question === undefined) {
      return 'the whole plan';
    }

    return question.kind === 'checkpoint' && question.checkpoint !== undefined
      ? `Checkpoint ${question.checkpoint.cp}`
      : itemTitle(question);
  };

  const history = useMemo(() => chatHistory(thread), [thread]);
  const tracks = useMemo(() => chatTracks(history), [history]);
  // Read at every step of the playlist, so new replies are played too.
  const latestTracks = useRef(tracks);
  latestTracks.current = tracks;
  const audible = new Set(tracks.map((track) => track.id));
  const waiting = pending.filter(
    (sent) =>
      !history.some(
        (message) =>
          message.from === 'human' &&
          message.text.trim() === sent.text &&
          Date.parse(message.createdAt) >= sent.at - 60_000
      )
  );
  // The dev owes a reply while the newest message is theirs.
  const last = history.filter((message) => message.from !== 'system').at(-1);
  const thinking =
    waiting.some((sent) => sent.failed !== true) ||
    (last !== undefined && last.from === 'human');

  // Scrolling, as in claude.ai: sending puts their message at the top of the
  // chat and nothing moves after — the reply fills in below it (a spacer
  // under the newest message makes room, shrinking as the reply grows), and
  // they scroll on through a long one themselves. Until they send, the chat
  // sits at its newest message and follows new ones while they're at the bottom.
  const log = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const anchored = useRef(false);
  const scrollToAnchor = useRef(false);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = log.current;
    const room = spacer.current;

    if (element === null || room === null) {
      return;
    }

    if (!anchored.current) {
      room.style.height = '0px';

      if (following.current) {
        element.scrollTop = element.scrollHeight;
      }

      return;
    }

    const yours = element.querySelectorAll<HTMLElement>('[data-you]');
    const mine = yours.item(yours.length - 1);

    if (mine === null) {
      return;
    }

    const below = room.offsetTop - mine.offsetTop;
    room.style.height = `${Math.max(0, element.clientHeight - below - 16)}px`;

    if (scrollToAnchor.current) {
      scrollToAnchor.current = false;
      element.scrollTop = mine.offsetTop - 16;
    }
  });

  // Images (and long markdown) settle after render, making the chat taller
  // with no re-render: while they're at the newest message — and hasn't just
  // sent one — stay there.
  useEffect(() => {
    const element = log.current;

    if (element === null) {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      if (!anchored.current && following.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    Array.from(element.children).forEach((child) => observer.observe(child));
    const watchNew = new MutationObserver(() =>
      Array.from(element.children).forEach((child) => observer.observe(child))
    );
    watchNew.observe(element, { childList: true });

    return () => {
      observer.disconnect();
      watchNew.disconnect();
    };
  }, []);

  // Another pod's chat: back to its newest message.
  useEffect(() => {
    anchored.current = false;
    following.current = true;
  }, [podLabel]);

  const send = (done: boolean): void => {
    const text = draft.trim();

    if (done) {
      onDraftChange('');
      onDone(text);

      return;
    }

    if (text === '') {
      return;
    }

    onDraftChange('');
    anchored.current = true;
    scrollToAnchor.current = true;
    onSend(text);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(event.metaKey || event.ctrlKey);
    }
  };

  return (
    <section
      className={`center-chat${drop.over ? ' center-chat--dropping' : ''}`}
      {...drop.zone}
    >
      {drop.over && (
        <div className="chat-panel__drop">Drop the image to attach it</div>
      )}
      <div
        className="chat-panel__log"
        ref={log}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            80;
        }}
      >
        {history.length === 0 && waiting.length === 0 && (
          <p className="muted chat__empty">
            Talk to {podLabel}&apos;s dev. ⏎ sends; ⌘⏎ when you&apos;re done
            with the item that&apos;s up.
          </p>
        )}
        {history.map((message, index) => {
          const previous = history[index - 1];
          // "About …" heads a run of messages on one item: answers carry it
          // as their qid, chat said while it was up as `about`.
          const topic = message.qid ?? message.about;
          const divider =
            topic !== undefined &&
            (previous === undefined ||
              (previous.qid ?? previous.about) !== topic);

          if (message.from === 'system') {
            return (
              <p key={message.id} className="muted chat__event">
                ✓ {message.text}
              </p>
            );
          }

          // The old side chat's decisions, pasted into an answer by the app
          // (not typed by them): one quiet line, the list a click away.
          if (
            message.from === 'human' &&
            message.text.startsWith(DECIDED_PREFIX)
          ) {
            const [decided, ...typed] = message.text.split('\n\n');
            const items = (decided ?? '')
              .slice(DECIDED_PREFIX.length)
              .split(/;\s*/)
              .map((item) => item.trim().replace(/\.$/, ''))
              .filter((item) => item !== '');

            return (
              <details key={message.id} className="muted chat__decided">
                <summary>
                  Your chat decisions, sent to the dev ({items.length})
                </summary>
                <ol>
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
                {typed.length > 0 && <p>{typed.join('\n\n')}</p>}
              </details>
            );
          }

          return (
            <div
              key={message.id}
              data-msg={message.id}
              data-you={message.from === 'human' ? '' : undefined}
            >
              {divider && (
                <p className="chat-panel__topic" data-topic={topic}>
                  About {topicLabel(topic)}
                </p>
              )}
              <Message
                from={message.from === 'human' ? 'you' : 'claude'}
                text={message.text}
                progress={message.progress === true}
                label={noteOf(message)}
                className={
                  listening?.msgId === message.id ? 'msg--listening' : ''
                }
              >
                {audible.has(message.id) && (
                  <button
                    type="button"
                    className="icon msg__listen"
                    title={
                      listening?.msgId === message.id
                        ? 'Stop'
                        : 'Listen from here to the newest message'
                    }
                    aria-label={
                      listening?.msgId === message.id
                        ? 'Stop listening'
                        : 'Listen from here'
                    }
                    onClick={() =>
                      onListen(message.id, () => latestTracks.current)
                    }
                  >
                    {listening?.msgId !== message.id ? (
                      <SpeakerIcon />
                    ) : listening.loading ? (
                      '…'
                    ) : (
                      '■'
                    )}
                  </button>
                )}
              </Message>
            </div>
          );
        })}
        {waiting.map((sent) => (
          <div key={sent.id} data-you="">
            <Message
              from="you"
              text={sent.text}
              className="msg--pending"
              label={sent.failed === true ? 'Not sent' : 'Sending'}
            >
              {sent.failed === true && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onRetry(sent)}
                >
                  Retry
                </button>
              )}
            </Message>
          </div>
        ))}
        {thinking && (
          <div
            className="msg msg--claude chat__typing"
            aria-label="Lambda is thinking"
          >
            <span className="typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        {whileWaiting}
        <div ref={spacer} className="chat-panel__spacer" aria-hidden="true" />
      </div>
      <footer className="chat-panel__compose">
        {context !== undefined && (
          <div className="chat-panel__about">{context}</div>
        )}
        <div className="image-drop">
          <textarea
            ref={box}
            rows={1}
            // Attached images are thumbnails under the box, not "[Image: …]"
            // lines in it; they travel with the words when it's sent.
            value={wordsOf(draft)}
            placeholder={`Reply to ${podLabel}`}
            onChange={(event) =>
              onDraftChange(withWords(draft, event.target.value))
            }
            onKeyDown={onKey}
          />
          {drop.tray}
        </div>
      </footer>
    </section>
  );
};
