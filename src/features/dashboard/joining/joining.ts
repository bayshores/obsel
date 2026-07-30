/**
 * How far a visiting agent has got, derived entirely from what is on the board.
 *
 * Same rule as `guide.ts`, for the same reason: there is no stored step
 * anywhere. Every render recomputes each tick from the swarm snapshot, so an
 * agent driven from a terminal, a half-finished attempt, and a task that
 * changes under us all land on the honest step instead of desyncing a stored
 * position.
 *
 * **What obsel cannot see decides the shape of this list.**
 *
 * obsel cannot see an agent's settings. Nothing here can tell whether somebody
 * pasted the command, edited a configuration file, or restarted their client,
 * so no step claims to. The command sits above the list as the thing to do, and
 * the first tick is that agent's own first call arriving. It is a weaker promise
 * than a setup wizard makes, and it is the only one obsel can keep.
 *
 * One thing obsel now does see: a client that connects names itself in the MCP
 * `initialize` handshake, and obsel records that against the task. It does not
 * move this list, and deliberately: a name is what the client called itself, not
 * evidence that a step happened, and every tick here stays a board fact. The
 * name is shown once, in the details panel beside the task it belongs to.
 *
 * The four steps are the order in `skills/obsel-collaboration/SKILL.md`, which
 * is the order that makes obsel's answers mean anything: declare, announce,
 * report, and then watch a change land. Each is a separate observable, so no
 * tick stands for two facts at once.
 *
 * Tool names are written out here. This is the one panel where that is right:
 * `register_task` is what a visiting agent calls, and it cannot be called by any
 * other name. `e2e/dashboard.spec.ts` excludes this panel from the bare-identifier
 * guard for exactly that reason.
 */

import { outputChanged } from "../fingerprints";
import { taskTitle } from "../naming";
import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * The taxi swarm's dataset namespace, which its forty tasks all write into.
 *
 * Mirrors `NAMESPACE` in `agents/scale.py`. Duplicated rather than imported,
 * exactly the way `naming.ts` duplicates `shortName`: this renders in the
 * browser, and browser code here does not import server modules. A test reads
 * the Python and asserts they agree.
 */
export const TAXI_NAMESPACE = "obsel_taxi";

/**
 * The four tasks obsel's own demonstration registers. `agents/pipeline.py`.
 *
 * **A namespace cannot do this job, and the first version of this file thought
 * it could.** It classified anything outside `obsel_demo` and `obsel_taxi` as a
 * visitor, which is exactly backwards for the people this panel is for:
 * `datasetUrn` in `src/server/datahub/urns.ts` qualifies any unnamespaced table
 * under `obsel_demo`, and the HTTP API takes short names, so a visiting agent
 * registering `expenses_csv` lands in `obsel_demo.expenses_csv` and would have
 * been counted as obsel's own. The panel would have sat at zero of four forever
 * while somebody's agent worked perfectly in front of it.
 *
 * The fixture did not catch it because the fixture was written to match the
 * belief, with a `finance.` prefix no real caller produces. What caught it was
 * asking what the MCP door actually emits, and then a real session through it.
 *
 * So the rule is inverted, which also puts the risk on the safe side. Obsel's
 * own work is the closed set: these four names, plus anything writing into the
 * taxi namespace. Everything else is a visitor. An unknown task is therefore a
 * visitor, so the panel works for a stranger and only an exact collision with
 * one of these four names misreads.
 */
export const DEMO_TASKS: readonly string[] = [
  "clean_orders",
  "build_revenue",
  "write_report",
  "write_docs",
];

/**
 * `urn:li:dataset:(urn:li:dataPlatform:obsel,obsel_demo.clean_orders,PROD)` to
 * `obsel_demo`. Null when the URN carries no namespace at all, which is not an
 * error: a visiting agent names its tables whatever it likes.
 */
function namespaceOf(datasetUrn: string): string | null {
  const parts = datasetUrn.split(",");
  const path = parts.length > 1 ? parts[1] : datasetUrn;
  const dot = path.indexOf(".");
  return dot === -1 ? null : path.slice(0, dot);
}

/**
 * Whether this task belongs to somebody who joined, rather than to obsel's own
 * demonstrations. See `DEMO_TASKS` for why obsel's own work is the closed set
 * rather than the other way round.
 *
 * The taxi half is judged on what the task touches, because those forty names
 * are generated and listing them here would be a copy that goes stale. Every
 * one of them reads and writes inside the taxi namespace, and that namespace is
 * in the URN obsel itself builds.
 */
export function isVisitor(task: TaskRecord): boolean {
  if (DEMO_TASKS.includes(task.name)) return false;
  const datasets = [...task.writes, ...task.reads];
  if (datasets.some((urn) => namespaceOf(urn) === TAXI_NAMESPACE)) return false;
  return true;
}

/** One thing a joining agent does, and whether obsel has seen it happen. */
export interface JoinStep {
  /**
   * Written in the past tense, so a ticked row reads as a fact about the
   * agent rather than as an instruction that has been obeyed.
   */
  name: string;
  done: boolean;
  /**
   * Not done: what to do, naming the tool that does it. Done: what obsel
   * actually observed, naming the task, so the tick can be checked rather
   * than trusted.
   */
  detail: string;
}

export interface JoinView {
  steps: JoinStep[];
  /** How many have happened, for the heading. */
  done: number;
  /** No visiting agent is on the board at all. */
  waiting: boolean;
  /**
   * Whether the steps should be painted rather than folded behind the heading.
   *
   * Open for the two readers who want them: somebody looking at a board with
   * nothing on it, and somebody whose own agent is part way through. Folded
   * once all four are done, because a finished checklist is furniture, and
   * folded while obsel's own demonstration is the only thing registered, which
   * is the state the board is in on camera. The heading and the count stay
   * visible either way: the fold is about how much prose is on screen, never
   * about whether a reader can find the door.
   */
  expanded: boolean;
  /** This machine's real command, or null while the runner has not said. */
  command: string | null;
}

export interface JoinInput {
  /**
   * Did the last swarm read succeed. Same flag the guide takes, and it is here
   * for one case: a failed read leaves `tasks` empty, which is indistinguishable
   * from a board nobody has registered anything on. Opening the steps then would
   * pop this panel open, tick nothing, and sit under a headline saying obsel
   * cannot see anything at all. An empty board only means "newcomer" when obsel
   * actually looked.
   */
  trusted: boolean;
  tasks: TaskRecord[];
  /** From `GET /api/demo/activity`, which builds it from this machine's paths. */
  command: string | null;
}

/** The first visitor for which the predicate holds, for naming a tick's subject. */
function firstWhere(
  visitors: readonly TaskRecord[],
  holds: (task: TaskRecord) => boolean,
): TaskRecord | null {
  return visitors.find(holds) ?? null;
}

export function joining(input: JoinInput): JoinView {
  const visitors = input.trusted ? input.tasks.filter(isVisitor) : [];

  const registered = visitors[0] ?? null;
  const announced = firstWhere(visitors, (task) => task.startedAt !== null);
  const reported = firstWhere(visitors, (task) => task.finishedAt !== null);
  const answered = firstWhere(visitors, (task) => task.stale !== null || outputChanged(task));

  const steps: JoinStep[] = [
    {
      name: "Your agent said what it reads and what it writes",
      done: registered !== null,
      detail:
        registered !== null
          ? `${taskTitle(registered)} is on the graph, with its tables wired to it.`
          : "It calls register_task once, naming the tables it reads and the tables it writes.",
    },
    {
      name: "It told obsel before it started writing",
      done: announced !== null,
      detail:
        announced !== null
          ? `${taskTitle(announced)} announced itself before it began.`
          : "It calls announce_start. obsel leaves work that is under way alone.",
    },
    {
      name: "It handed obsel what it produced",
      done: reported !== null,
      detail:
        reported !== null
          ? `${taskTitle(reported)} reported its table, and obsel recorded what it looked like.`
          : "It calls report_complete with the table. obsel takes the fingerprint itself.",
    },
    {
      name: "obsel answered a change to your data",
      done: answered !== null,
      detail:
        answered !== null
          ? `obsel has seen ${taskTitle(answered)}'s table change since it was first recorded.`
          : "Change one of those tables and have the agent report the work again. " +
            "Whatever was built on it is what gets flagged.",
    },
  ];

  const done = steps.filter((step) => step.done).length;
  const waiting = visitors.length === 0;
  return {
    steps,
    done,
    waiting,
    expanded:
      input.trusted && ((input.tasks.length === 0 && waiting) || (!waiting && done < steps.length)),
    command: input.command,
  };
}
