/**
 * Where each node sits, decided by dagre.
 *
 * This replaces about 250 lines of hand-written geometry: box packing, bezier
 * control points, a collision test that hunted for a clear horizontal lane when
 * an edge would otherwise cross a box, and per-character width reservation so
 * labels never overflowed. All of it worked, and all of it was a layered-DAG
 * layout engine being rediscovered badly. dagre is that engine.
 *
 * What is left here is only the translation between obsel's vocabulary and
 * dagre's: a task is a node, a dataset is a node, `reads` and `writes` are
 * edges. Sizes are fixed because the node components have fixed sizes, and
 * dagre needs to know them to reserve space.
 *
 * Deliberately pure and free of React, so the layout is testable without
 * rendering anything and cannot depend on measurement of a live DOM.
 */

import dagre from "@dagrejs/dagre";

import type { TaskRecord } from "@/src/server/coordinator/types";

/**
 * Node footprints, in pixels, matching the CSS on the node components.
 *
 * A task box is wider than a dataset box because it carries a human title plus a
 * status line; a dataset box carries a table name and, on the one that changed, a
 * two-line column diff. These are the numbers dagre reserves space with, so a box
 * that outgrows them overlaps its neighbour: they are duplicated in
 * `lineage.module.css` and a test asserts the two agree.
 */
export const TASK_SIZE = { width: 168, height: 56 } as const;
export const DATA_SIZE = { width: 152, height: 56 } as const;

/** A dataset node grows when it carries a column diff, which needs two more lines. */
export const DATA_SIZE_WITH_DIFF = { width: 176, height: 84 } as const;

export type NodeKind = "task" | "data";

export interface PositionedNode {
  /** `t:<taskUrn>` or `d:<datasetUrn>`, the same key space the cascade uses. */
  id: string;
  kind: NodeKind;
  /** Top-left, which is what React Flow positions from. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedEdge {
  /** `${from}->${to}`, matching `cascadeEdges`' key exactly. */
  id: string;
  from: string;
  to: string;
  kind: "read" | "write";
}

export interface Positions {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

/** The node id for a task, and for a dataset. One spelling, used everywhere. */
export const taskNodeId = (urn: string): string => `t:${urn}`;
export const dataNodeId = (urn: string): string => `d:${urn}`;

/**
 * Lay the swarm out left to right.
 *
 * `rankdir: LR` because the pipeline is read as a flow from raw input to final
 * report, and because a wide frame has width to spare and height to save.
 *
 * Status is never consulted here, which is the same discipline the old layout
 * kept and worth keeping for the same reason: nothing moves when three tasks flip
 * amber. A viewer watching the cascade sees colour and motion arrive on a
 * stationary graph, so they can follow it. If position depended on status, the
 * whole picture would rearrange at the one moment someone is trying to read it.
 *
 * `datasetsWithDiff` widens exactly the nodes that will render a column diff, so
 * dagre reserves the taller footprint rather than letting the box overlap what
 * dagre thought was empty space.
 */
export function layoutPositions(
  tasks: TaskRecord[],
  datasetsWithDiff: ReadonlySet<string> = new Set(),
): Positions {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "LR",
    /*
     * Tuned against the four-task demo at the recording width.
     *
     * `ranksep` is the gap between columns and is what the arrows live in;
     * `nodesep` separates nodes within a column. The demo lays out seven ranks,
     * so every pixel of `ranksep` costs six pixels of total width, and total
     * width is what decides how far `fitView` has to zoom out. 48 keeps the
     * arrows clearly readable while landing the whole graph close to zoom 1,
     * where the node text renders at the size it was designed for.
     */
    ranksep: 48,
    nodesep: 20,
    marginx: 12,
    marginy: 12,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const seenDatasets = new Set<string>();
  const addDataset = (urn: string): void => {
    if (seenDatasets.has(urn)) return;
    seenDatasets.add(urn);
    const size = datasetsWithDiff.has(urn) ? DATA_SIZE_WITH_DIFF : DATA_SIZE;
    graph.setNode(dataNodeId(urn), { ...size });
  };

  for (const task of tasks) {
    graph.setNode(taskNodeId(task.urn), { ...TASK_SIZE });
    for (const input of task.reads) addDataset(input);
    for (const output of task.writes) addDataset(output);
  }

  const edges: PositionedEdge[] = [];
  for (const task of tasks) {
    for (const input of task.reads) {
      const from = dataNodeId(input);
      const to = taskNodeId(task.urn);
      graph.setEdge(from, to);
      edges.push({ id: `${input}->${task.urn}`, from, to, kind: "read" });
    }
    for (const output of task.writes) {
      const from = taskNodeId(task.urn);
      const to = dataNodeId(output);
      graph.setEdge(from, to);
      edges.push({ id: `${task.urn}->${output}`, from, to, kind: "write" });
    }
  }

  dagre.layout(graph);

  const nodes: PositionedNode[] = graph.nodes().map((id) => {
    const node = graph.node(id);
    return {
      id,
      kind: id.startsWith("t:") ? "task" : "data",
      // dagre centres its nodes; React Flow positions from the top-left corner.
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
    };
  });

  const graphSize = graph.graph();
  return {
    nodes,
    edges,
    width: graphSize.width ?? 0,
    height: graphSize.height ?? 0,
  };
}
