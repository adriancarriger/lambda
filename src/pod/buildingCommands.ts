import { type Command } from 'commander';

/**
 * The building-pod subcommands of `lambda pod`: an Engineering manager, a dev
 * and qa building Ready tickets, with a Product manager to talk to.
 *
 * Registered by `registerPodCommand`, which hands over its `run` wrapper and
 * owner-name help rewriter. Every action imports its implementation lazily.
 */

export interface PodCommandHelpers {
  /** Wraps an action so a thrown error prints and sets the exit code. */
  run: <A extends unknown[]>(
    action: (...args: A) => Promise<void> | void
  ) => (...args: A) => Promise<void>;
  /** Names the owner in help text an agent reads. */
  o: (text: string) => string;
}

const relay = () => import('./relay');
const ask = () => import('./ask');
const peek = () => import('./peek');
const buildingLifecycle = () => import('../building/lifecycle');
const blocked = () => import('../building/blocked');
const skipTicket = () => import('../building/skipTicket');
const screenshots = () => import('../building/screenshots');
const productManager = () => import('../building/productManager');
const talk = () => import('../building/talkAboutTicket');

export const registerBuildingCommands = (
  pod: Command,
  { run, o }: PodCommandHelpers
): void => {
  pod
    .command('build')
    .description(
      "Start building: a building pod on this computer works through the codebase's Ready tickets, one at a time"
    )
    .option('--project-id <id>', "(internal) The mothership's project id")
    .option('--no-launch', 'Create state only; do not start agents')
    .option('--paused', 'Make it paused: it takes no ticket until resumed')
    .action(
      run(
        async (options: {
          projectId?: string;
          launch: boolean;
          paused?: boolean;
        }) => {
          await (await buildingLifecycle()).runBuild(options);
        }
      )
    );

  pod
    .command('blocked <ticket-id>')
    .description(
      o(
        "(Engineering manager) Set the ticket aside: a four-part item in the owner's inbox, the ticket blocked, and the pod moves on"
      )
    )
    .option('--pod <id>')
    .option('--what <text>', 'What the ticket is for')
    .option('--problem <text>', 'What stops it')
    .option('--options <text>', 'The choices, numbered')
    .option('--recommendation <text>', 'Which one, and why')
    .option(
      '--visual',
      "The visual check blocked it: fill the parts you don't pass from its record"
    )
    .option(
      '--pause',
      "The problem isn't the ticket's, so the next one would stop the same way: pause the pod after this block"
    )
    .option(
      '--left-lambda',
      'It was taken out of Lambda in its tracker: block it here only, leaving its status there alone'
    )
    .action(
      run(
        async (
          ticketId: string,
          options: {
            pod?: string;
            what?: string;
            problem?: string;
            options?: string;
            recommendation?: string;
            visual?: boolean;
            leftLambda?: boolean;
            pause?: boolean;
          }
        ) => {
          const { openStore, openTickets, resolvePodId } = await import(
            './context'
          );
          await (
            await blocked()
          ).blockTicket({
            store: openStore(),
            podId: resolvePodId(options.pod),
            ticketId,
            parts: {
              what: options.what,
              problem: options.problem,
              options: options.options,
              recommendation: options.recommendation,
            },
            source: openTickets(),
            visual: options.visual === true,
            leftLambda: options.leftLambda === true,
            pause: options.pause === true,
          });
          const pod = openStore().readPod(resolvePodId(options.pod));
          console.log(
            pod?.status === 'paused'
              ? `${ticketId} is blocked, and the pod is paused: it takes no more tickets until the owner resumes it.`
              : `${ticketId} is blocked; the pod takes the next ticket.`
          );
        }
      )
    );

  pod
    .command('skip-ticket <pod-id> <ticket-id>')
    .description(
      "(Engineering manager) Leave a ticket out of this pod's queue for the life of the pod"
    )
    .action(
      run(async (podId: string, ticketId: string) => {
        const { callerAgent, openStore, openTickets } = await import(
          './context'
        );
        await (
          await skipTicket()
        ).runSkipTicket(podId, ticketId, {
          store: openStore(),
          source: openTickets(),
          caller: callerAgent(),
        });
      })
    );

  pod
    .command('screenshot <file>')
    .description(
      "(qa) Record a test screenshot under the current ticket's test attempt"
    )
    .option('--pod <id>', 'Pod id (agents get POD_ID automatically)')
    .requiredOption('--url <url>', 'The page it shows')
    .option(
      '--console <line>',
      'A console error (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .requiredOption('--conclusion <text>', 'One line: what it shows')
    .option('--passed', 'It shows the check passing')
    .option('--failed', 'It shows the check failing')
    .action(
      run(
        async (
          file: string,
          options: {
            pod?: string;
            url?: string;
            console?: string[];
            conclusion?: string;
            passed?: boolean;
            failed?: boolean;
          }
        ) => (await screenshots()).runScreenshot(options.pod, file, options)
      )
    );

  pod
    .command('pm-chat <id> <text...>')
    .description(
      o("The owner's chat message to a building pod's Product manager")
    )
    .action(
      run(async (id: string, text: string[]) => {
        await (await productManager()).runPmChat(id, text.join(' '));
        console.log('Sent to the Product manager.');
      })
    );

  pod
    .command('talk-ticket <ticket-id> <text...>')
    .description(
      'Talk about this ticket: with the building pod’s Product manager, the planning dev, or a one-off Product manager'
    )
    .action(
      run(async (ticketId: string, text: string[]) =>
        (await talk()).runTalkTicket(ticketId, text.join(' '))
      )
    );

  pod
    .command('watch-building <id>')
    .description(
      "(internal) The runner's minute watch: the Product manager sleeps after 30 quiet minutes, an ask fork after 15"
    )
    .action(
      run(async (id: string) => {
        const { openStore: store } = await import('./context');
        const asleep = (await productManager()).sleepIdleProductManager(
          store(),
          id
        );
        const closed = (await ask()).closeIdleAsks(store(), id);
        console.log(
          `${asleep ? 'Product manager asleep. ' : ''}${
            closed.length
          } conversation(s) closed.`
        );
      })
    );

  pod
    .command('peek <window>')
    .description(
      '(Product manager) What a pod window shows; captures only, never sends'
    )
    .option('--pod <id>')
    .option('--lines <n>', 'Scrollback lines', '60')
    .action(
      run(async (window: string, options: { pod?: string; lines: string }) =>
        (await peek()).runPeek(window, {
          pod: options.pod,
          lines: Number(options.lines),
        })
      )
    );

  pod
    .command('ask [target] [question...]')
    .description(
      '(Product manager) Ask a read-only fork of the engineering-manager or the dev; prints the conversation id, then its answer'
    )
    .option('--pod <id>')
    .option('--thread <id>', 'Ask the same fork again')
    .option('--close <id>', 'Spin that conversation down')
    .option(
      '--wait',
      'With --thread: keep waiting for its answer, asking nothing (exit 2: still answering, run it again)'
    )
    .action(
      run(
        async (
          target: string | undefined,
          question: string[] | undefined,
          options: {
            pod?: string;
            thread?: string;
            close?: string;
            wait?: boolean;
          }
        ) => {
          await (
            await ask()
          ).runAsk(target ?? '', (question ?? []).join(' '), options);
        }
      )
    );

  pod
    .command('relay <decision...>')
    .description(
      o("(Product manager) Hand the owner's call to the Engineering manager")
    )
    .option('--pod <id>')
    .action(
      run(async (decision: string[], options: { pod?: string }) =>
        (await relay()).runRelay(decision.join(' '), options)
      )
    );
};
