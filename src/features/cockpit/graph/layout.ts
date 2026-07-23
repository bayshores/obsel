/**
 * Where every node and edge of the lineage graph is drawn.
 *
 * Pure. Input is the task list `GET /api/swarm` returns; output is geometry.
 * No DOM, no React, no measurement pass — which is what makes the three rules
 * below testable rather than aspirational.
 *
 * **1. Nothing is hardcoded.** No task name, node count, coordinate or column
 * appears in this file. Register a fifth task and it draws; rename one and it
 * draws. The first version of this graph placed nine named boxes at hand-picked
 * x/y, which meant it silently drew the wrong pipeline for any swarm but the
 * demo one — a dashboard that lies quietly, which is the exact failure obsel
 * exists to prevent.
 *
 * **2. No text can overflow its box.** Every box takes its width from the widest
 * string it must hold. The face is monospace, so width is a pure function of
 * character count and needs no browser to compute.
 *
 * **3. Layout is a function of topology, never of status.** `status` is not read
 * anywhere below, and this is the rule that is easiest to break by accident —
 * see `reserveText`.
 */

import { datasetTitle, shortName, taskTitle } from "../naming";
import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * Advance per character in Geist Mono, measured in-browser with `getBBox()` at
 * each size the cockpit uses: "clean_orders" is 96.7px at 13px (12 chars),
 * 82.6px at 11px, and "s c2e19b7d" is 62.8px at 10px.
 *
 * A lookup rather than a ratio because the three sizes do not scale linearly
 * off one number, and a 2% error here is a clipped descender on camera.
 */
const ADVANCE: Record<number, number> = { 10: 6.28, 11: 6.885, 13: 8.06 };

function textWidth(text: string, px: 10 | 11 | 13): number {
  return text.length * ADVANCE[px];
}

/** Task box: name (13px), status line (11px), finished clock (11px). */
export const TASK_BOX = {
  padX: 12,
  padY: 11,
  lineName: 18,
  lineSub: 15,
  minWidth: 132,
} as const;

/** Dataset box: name (11px), schema print (10px), content print (10px). */
export const DATA_BOX = {
  padX: 10,
  padY: 8,
  line: 14,
  minWidth: 100,
} as const;

export const TASK_HEIGHT = TASK_BOX.padY * 2 + TASK_BOX.lineName + TASK_BOX.lineSub * 2;
export const DATA_HEIGHT = DATA_BOX.padY * 2 + DATA_BOX.line * 3;

const COL_GAP = 52; // between pipeline stages
const GROUP_GAP = 30; // between parallel branches inside one stage
const ATTACH_GAP = 16; // a task box to the dataset it writes
const DATA_STACK_GAP = 6; // between two datasets the same task writes

/**
 * The widest the task box's third line can be.
 *
 * That line used to be a bare `17:23:52` — and so did the ledger's right-hand
 * column, except the ledger showed `mark.since` while the graph showed
 * `finishedAt`. Two unlabelled eight-character monospace timestamps, differing
 * for every stale task, with nothing on screen saying they measure different
 * things. Both are labelled now, and the label has to be reserved for or it
 * would overflow the box. Constant, so it cannot vary with status.
 */
const CLOCK_RESERVE = "finished 00:00:00";
const PAD_X = 18;
const PAD_TOP = 30; // headroom for the "changed · schema" caption
const PAD_BOTTOM = 14;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "task" | "data";
}

export interface GraphEdge {
  /** `${fromUrn}->${toUrn}`. The same key `cascadeEdges` returns. */
  id: string;
  /** Box key: `t:<urn>` or `d:<urn>`. */
  from: string;
  to: string;
  /** `read` is dataset → task; `write` is task → the dataset it produces. */
  kind: "read" | "write";
}

export interface GraphLayout {
  /** Keyed `t:<taskUrn>` and `d:<datasetUrn>`. */
  boxes: Record<string, Box>;
  edges: GraphEdge[];
  /** viewBox width and height. Both depend only on topology. */
  width: number;
  height: number;
  /** Which task writes each dataset, for callers that need the fingerprint. */
  producerOf: Record<string, TaskRecord>;
  /**
   * A clear horizontal lane below every box, for edges that skip a column.
   *
   * An edge from column 0 to column 3 — an audit task reading both the source
   * table and the final report, say — was drawn as a direct curve, straight
   * through whatever boxes sat between, over their names and status text. Those
   * edges are routed along this lane instead. Null when no edge needs it, so
   * the common graph reserves no space for it.
   */
  detourY: number | null;
}

/**
 * Which pipeline stage each task belongs to: one past the deepest stage of any
 * task producing data it reads.
 *
 * The `open` set is not defensive decoration. CLAUDE.md requires a cyclic graph
 * to terminate rather than hang; a task reached while it is still being resolved
 * returns 0 and the walk unwinds instead of recursing forever.
 */
function stageOf(tasks: TaskRecord[]): {
  stage: Record<string, number>;
  producerOf: Record<string, TaskRecord>;
} {
  /*
   * LAST writer wins, deliberately, because that is what the engine does:
   * `affectedBy` in src/server/coordinator/staleness.ts builds its map with an
   * unconditional `producerOf.set(output, task)`.
   *
   * When two tasks declare the same output — which the register endpoint
   * accepts — the two rules pick different producers. The engine would name one
   * task as the cause of a change while the graph drew the other one's
   * fingerprint as the evidence for it, so the picture and the mark would
   * disagree about which task moved the data. A cosmetic-looking `if` was the
   * whole difference.
   */
  const producerOf: Record<string, TaskRecord> = {};
  for (const task of tasks) {
    for (const output of task.writes) producerOf[output] = task;
  }

  const stage: Record<string, number> = {};
  const open: Record<string, boolean> = {};

  function resolve(task: TaskRecord): number {
    const settled = stage[task.urn];
    if (settled !== undefined) return settled;
    if (open[task.urn]) return 0; // cycle — stop, do not recurse
    open[task.urn] = true;

    let deepest = -1;
    for (const input of task.reads) {
      const producer = producerOf[input];
      if (producer !== undefined && producer.urn !== task.urn) {
        deepest = Math.max(deepest, resolve(producer));
      }
    }

    open[task.urn] = false;
    stage[task.urn] = deepest + 1;
    return stage[task.urn];
  }

  for (const task of tasks) resolve(task);
  return { stage, producerOf };
}

/**
 * One column entry: a task with every dataset it produces stacked beneath it,
 * or a lone source dataset nobody in this swarm writes.
 *
 * `datasets` is a list, not a single slot. It held one dataset once, and a task
 * declaring two outputs — which `POST /api/tasks/register` accepts, and which
 * `TaskRecord.writes: string[]` has always allowed — silently lost the second
 * one: no box, no edge, and no error. The graph simply drew a smaller pipeline
 * than the swarm it was reading.
 */
interface Group {
  col: number;
  task: TaskRecord | null;
  datasets: string[];
  w: number;
  h: number;
}

function groupLabel(group: Group): string {
  if (group.task !== null) return group.task.name;
  return group.datasets.length > 0 ? shortName(group.datasets[0]) : "";
}

/**
 * Lay the graph out.
 *
 * One column per pipeline stage. A dataset is drawn attached directly beneath
 * the task that writes it, because that pairing is what a fingerprint belongs
 * to — the task's claim and the evidence for it read as one unit. A dataset
 * nobody in the swarm writes is a source, and gets its own column ahead of
 * everything that reads it.
 *
 * @param reserveText The widest status line ANY task could ever display —
 *   derived from the shape of the graph, never from what a task currently says.
 *   This parameter is rule 3 made unavoidable. Passing the *current* label looks
 *   right and is not: "out of date · 2 hops" is wider than "done", so boxes
 *   would grow, the viewBox would widen, and the whole graph would rescale on
 *   exactly the frame three tasks flip amber — the one moment nothing may move.
 *   Measured before this parameter existed: the viewBox went 688 → 754 between
 *   the calm and cascade states. Use {@link reserveFor} to build it.
 */
export function layoutGraph(tasks: TaskRecord[], reserveText: string): GraphLayout {
  const { stage, producerOf } = stageOf(tasks);
  const groups: Group[] = [];
  const claimed = new Set<string>();

  for (const task of tasks) {
    // Every output this task is the producer of, in a stable order. A dataset
    // written by two tasks belongs to whichever the producer map named, so it is
    // drawn exactly once and under the same task the engine would blame.
    const attached = task.writes
      .filter((output) => producerOf[output] === task && !claimed.has(output))
      .sort((a, b) => shortName(a).localeCompare(shortName(b)));
    for (const output of attached) claimed.add(output);
    groups.push({ col: stage[task.urn], task, datasets: attached, w: 0, h: 0 });
  }

  // sources: read by someone, written by nobody in this swarm
  for (const task of tasks) {
    for (const input of task.reads) {
      if (producerOf[input] !== undefined || claimed.has(input)) continue;
      claimed.add(input);
      groups.push({ col: stage[task.urn] - 1, task: null, datasets: [input], w: 0, h: 0 });
    }
  }

  const minCol = groups.reduce((least, g) => Math.min(least, g.col), 0);
  for (const group of groups) group.col -= minCol;

  // Size every group from its own text. Rules 2 and 3, together.
  for (const group of groups) {
    let w = 0;
    let h = 0;
    if (group.task !== null) {
      w = Math.max(
        TASK_BOX.minWidth,
        // Reserved for what is DRAWN, which is the human title, not the code
        // identifier beneath it. Reserving for `name` while rendering the title
        // is how text escapes a box — and the title is usually the longer of the
        // two ("Orders cleaner" against "clean_orders" is a wash; "Daily
        // revenue" against "build_revenue" is not).
        textWidth(taskTitle(group.task), 13) + TASK_BOX.padX * 2,
        textWidth(reserveText, 11) + TASK_BOX.padX * 2,
        textWidth(CLOCK_RESERVE, 11) + TASK_BOX.padX * 2,
      );
      h = TASK_HEIGHT;
    }
    for (const dataset of group.datasets) {
      w = Math.max(w, DATA_BOX.minWidth, textWidth(datasetTitle(dataset), 11) + DATA_BOX.padX * 2);
    }
    if (group.datasets.length > 0) {
      // one gap above the first box, then the boxes themselves stacked tight
      h += (group.task !== null ? ATTACH_GAP : 0) + DATA_HEIGHT * group.datasets.length;
      h += DATA_STACK_GAP * (group.datasets.length - 1);
    }
    group.w = w;
    group.h = h;
  }

  const colWidth = new Map<number, number>();
  for (const group of groups) {
    colWidth.set(group.col, Math.max(colWidth.get(group.col) ?? 0, group.w));
  }
  const cols = [...colWidth.keys()].sort((a, b) => a - b);

  const colX = new Map<number, number>();
  let x = PAD_X;
  for (const col of cols) {
    colX.set(col, x);
    x += (colWidth.get(col) ?? 0) + COL_GAP;
  }
  const width = x - COL_GAP + PAD_X;

  // Alphabetical inside a column so the order cannot jitter between polls.
  const byCol = new Map<number, Group[]>();
  for (const col of cols) {
    byCol.set(
      col,
      groups
        .filter((g) => g.col === col)
        .sort((a, b) => groupLabel(a).localeCompare(groupLabel(b))),
    );
  }

  const stackHeight = (col: number): number => {
    const inCol = byCol.get(col) ?? [];
    return inCol.reduce((sum, g) => sum + g.h, GROUP_GAP * (inCol.length - 1));
  };
  const tallest = cols.reduce((most, col) => Math.max(most, stackHeight(col)), 0);
  const height = PAD_TOP + tallest + PAD_BOTTOM;

  const boxes: Record<string, Box> = {};
  for (const col of cols) {
    let y = PAD_TOP + (tallest - stackHeight(col)) / 2;
    for (const group of byCol.get(col) ?? []) {
      const gx = (colX.get(col) ?? 0) + ((colWidth.get(col) ?? 0) - group.w) / 2;
      if (group.task !== null) {
        boxes[`t:${group.task.urn}`] = { x: gx, y, w: group.w, h: TASK_HEIGHT, kind: "task" };
        y += TASK_HEIGHT + (group.datasets.length > 0 ? ATTACH_GAP : 0);
      }
      group.datasets.forEach((dataset, i) => {
        if (i > 0) y += DATA_STACK_GAP;
        boxes[`d:${dataset}`] = { x: gx, y, w: group.w, h: DATA_HEIGHT, kind: "data" };
        y += DATA_HEIGHT;
      });
      y += GROUP_GAP;
    }
  }

  const edges: GraphEdge[] = [];
  for (const task of tasks) {
    for (const input of task.reads) {
      if (boxes[`d:${input}`] !== undefined) {
        edges.push({
          id: `${input}->${task.urn}`,
          from: `d:${input}`,
          to: `t:${task.urn}`,
          kind: "read",
        });
      }
    }
    for (const output of task.writes) {
      if (boxes[`d:${output}`] !== undefined && producerOf[output] === task) {
        edges.push({
          id: `${task.urn}->${output}`,
          from: `t:${task.urn}`,
          to: `d:${output}`,
          kind: "write",
        });
      }
    }
  }

  /*
   * Does any read edge pass over a box on its way? An edge is a "skipper" when
   * some third box sits horizontally between its endpoints and vertically
   * overlaps the straight line it would otherwise take. Those get routed along
   * a clear lane instead, and only then is space reserved for one.
   */
  const allBoxes = Object.values(boxes);
  const skips = edges.some((edge) => {
    if (edge.kind !== "read") return false;
    const a = boxes[edge.from];
    const b = boxes[edge.to];
    const left = a.x + a.w;
    const right = b.x;
    if (right <= left) return false;
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return allBoxes.some(
      (box) =>
        box !== a &&
        box !== b &&
        box.x < right &&
        box.x + box.w > left &&
        box.y < bottom &&
        box.y + box.h > top,
    );
  });

  const lowest = allBoxes.reduce((most, box) => Math.max(most, box.y + box.h), 0);
  const detourY = skips ? lowest + 18 : null;

  return {
    boxes,
    edges,
    width,
    height: detourY === null ? height : Math.max(height, detourY + PAD_BOTTOM),
    producerOf,
    detourY,
  };
}

/**
 * The widest status line any task in this graph could ever show.
 *
 * Both halves come from topology: the longest status word is a constant of the
 * vocabulary, and a cascade cannot reach further than there are tasks to reach,
 * so `tasks.length` bounds the hop count. Nothing here reads a task's state,
 * which is why the geometry does not move when three tasks flip to amber.
 */
export function reserveFor(tasks: TaskRecord[], longestStatusWord: string): string {
  return `${longestStatusWord}  · ${tasks.length} hops`;
}

/**
 * Which lineage edges the cascade lit, and on which wave.
 *
 * Walked forward from the dataset the mark names, through the same filter the
 * engine actually applied — which is not the same as re-deciding it here.
 *
 * **A task is part of this cascade only if it carries a mark naming this
 * origin.** An earlier version instead re-walked the graph from the origin and
 * admitted any task that was currently `complete` or `stale`, on the theory
 * that re-deriving from topology could not disagree with topology. It could
 * disagree with something more important: the marks. A task downstream of the
 * change that the engine did NOT mark — because it was running when the cascade
 * ran, or because it finished afterwards and is therefore built on the new data
 * — is `complete` by the time the cockpit polls, so the walk lit an amber path
 * straight through it. The graph asserted the change had reached work obsel had
 * decided it did not reach.
 *
 * Hop numbers are read off the marks for the same reason. The mark is what
 * obsel decided and what it wrote into DataHub; if a re-derivation and the mark
 * ever differ, the mark is right and the picture is wrong.
 *
 * Returns an empty map when nothing carries a mark for this origin, which is
 * what makes the calm states calm. Terminates on a cyclic graph: both visited
 * sets are consulted before anything is enqueued.
 *
 * @returns edge id (`${from}->${to}`) → the hop count recorded on the mark.
 */
export function cascadeEdges(
  tasks: TaskRecord[],
  originDataset: string | null,
  causeTaskUrn: string | null,
): Record<string, number> {
  const lit: Record<string, number> = {};
  if (originDataset === null) return lit;

  // Only tasks obsel marked for THIS change, with the distance it recorded.
  const markedHere = new Map<string, number>();
  for (const task of tasks) {
    if (task.urn === causeTaskUrn) continue;
    if (task.stale !== null && task.stale.causedBy === originDataset) {
      markedHere.set(task.urn, task.stale.hops);
    }
  }
  if (markedHere.size === 0) return lit;

  const readersOf = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    for (const input of task.reads) {
      const list = readersOf.get(input);
      if (list === undefined) readersOf.set(input, [task]);
      else list.push(task);
    }
  }

  const seenData = new Set<string>([originDataset]);
  const seenTask = new Set<string>();
  let frontier: string[] = [originDataset];
  let rounds = 0;

  while (frontier.length > 0 && rounds < tasks.length + 2) {
    rounds += 1;
    const next: string[] = [];
    for (const dataset of frontier) {
      for (const task of readersOf.get(dataset) ?? []) {
        if (seenTask.has(task.urn)) continue;
        const hops = markedHere.get(task.urn);
        if (hops === undefined) continue; // obsel did not mark it — do not claim it did
        seenTask.add(task.urn);
        lit[`${dataset}->${task.urn}`] = hops;
        for (const output of task.writes) {
          lit[`${task.urn}->${output}`] = hops;
          if (!seenData.has(output)) {
            seenData.add(output);
            next.push(output);
          }
        }
      }
    }
    frontier = next;
  }

  return lit;
}
