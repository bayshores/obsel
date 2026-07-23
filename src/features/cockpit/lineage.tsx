"use client";

/**
 * obsel's read of the lineage graph, drawn by React Flow.
 *
 * This replaced roughly 800 lines of hand-written SVG: bezier control points, a
 * collision test that searched for a clear horizontal lane whenever an edge would
 * otherwise cross a box, two `<marker>` definitions for the arrowheads, and
 * per-character width reservation so a label could never overflow the rectangle
 * it was centred in. It worked. It was also a layered-graph renderer being
 * reinvented, and it looked like one.
 *
 * Two properties of the old version are kept deliberately, because they are about
 * correctness rather than drawing:
 *
 * - **Position never depends on status.** `layoutPositions` is not given a status,
 *   so nothing moves when three tasks flip amber. The cascade arrives as colour
 *   and motion on a stationary graph, which is what makes it followable.
 * - **`cascadeEdges` decides which path is lit**, by reading hop counts off the
 *   marks obsel wrote rather than re-deriving them from topology. A path is drawn
 *   only through tasks obsel actually marked.
 *
 * The animation is now continuous rather than a one-shot. The previous version
 * used `animation: … forwards`, so the cascade drew once over one duration and
 * then froze for the rest of the session: in a screenshot, and for anyone who
 * arrived a second late, the propagation the whole product is about was simply
 * not there.
 */

import { useEffect, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";

import { cascadeEdges } from "./graph/cascade";
import { dataNodeId, layoutPositions, taskNodeId } from "./graph/positions";
import { DataNode, TaskNode } from "./nodes";
import type { DataNodeData, TaskNodeData } from "./nodes";
import { currentChange } from "./timing";
import { STALE } from "./tone";
import type { StaleMark, TaskRecord } from "@/src/server/coordinator/types";

import "@xyflow/react/dist/style.css";
import styles from "./lineage.module.css";

/** Registered once, outside the component: React Flow warns on a new object per render. */
const NODE_TYPES = { task: TaskNode, data: DataNode };

/**
 * Interaction is off.
 *
 * This is a board someone reads, and during a recording it is a board someone
 * points a camera at. Pan, zoom, node dragging and selection all offer ways for
 * the picture to end up somewhere other than where it was laid out, with no
 * upside for a four-node graph that fits.
 */
const LOCKED = {
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: false,
  panOnDrag: false,
  panOnScroll: false,
  zoomOnScroll: false,
  zoomOnPinch: false,
  zoomOnDoubleClick: false,
  preventScrolling: false,
} as const;

/**
 * How the graph is framed, named once because it is applied in three places.
 *
 * `maxZoom` is a ceiling on scaling UP, so a two-task swarm on a large display
 * cannot render as a pair of enormous boxes. 1.25 rather than 1: the demo's
 * layout is wider than it is tall, so width pins the zoom before this ceiling is
 * reached anyway, and on a 1920 frame the extra headroom is the difference
 * between 13px and 15px node labels in a recording. Padding leaves room for the
 * arrowheads and for the changed table's taller box.
 */
const FIT = { padding: 0.08, maxZoom: 1.25 } as const;

/**
 * Everything the picture depends on, as one comparable string.
 *
 * Deliberately not the whole snapshot. `SwarmSnapshot.at` is restamped on every
 * poll, so no signature that included it could ever match twice, and the point of
 * this is to recognise the common case: a second passed and nothing changed.
 * Timestamps a node actually displays are absent for the same reason they are
 * absent from the nodes: the graph shows status, hops and the column diff, and
 * nothing that ticks.
 */
function graphSignature(tasks: TaskRecord[], origin: StaleMark | null): string {
  return JSON.stringify([
    tasks.map((task) => [
      task.urn,
      task.title,
      task.status,
      task.reads,
      task.writes,
      task.stale && [task.stale.causedBy, task.stale.hops],
    ]),
    origin && [origin.causedBy, origin.causedByTask, origin.columns],
  ]);
}

/** Pure: the swarm in, React Flow's nodes and edges out. */
function buildGraph(
  tasks: TaskRecord[],
  origin: StaleMark | null,
): { nodes: Node[]; edges: Edge[] } {
  const originDataset = origin?.causedBy ?? null;
  const causeTaskUrn = origin?.causedByTask ?? null;
  const lit = cascadeEdges(tasks, originDataset, causeTaskUrn);

  // Only the origin renders a diff, and only when obsel recorded one, so only
  // that node needs the taller footprint reserved for it.
  const withDiff = new Set<string>(
    originDataset !== null && origin?.columns ? [originDataset] : [],
  );
  const placed = layoutPositions(tasks, withDiff);

  const writers = new Set<string>();
  for (const task of tasks) for (const output of task.writes) writers.add(output);

  const byUrn = new Map(tasks.map((task) => [taskNodeId(task.urn), task]));

  const nodes: Node[] = placed.nodes.map((node) => {
    /*
     * Position from dagre; size left for React Flow to measure.
     *
     * Passing `width`/`height` here looked like the obvious way to make edges
     * computable on the first render, and it was wrong. React Flow treats given
     * dimensions as a reason to skip its own measurement pass, and that pass is
     * what populates each node's `handleBounds`. Without handle bounds
     * `getEdgePosition` returns null and every edge is silently dropped: nine
     * boxes on screen, zero lines between them, and no warning anywhere. A
     * lineage graph with no lineage in it.
     */
    const box = { position: { x: node.x, y: node.y }, draggable: false };
    if (node.kind === "task") {
      const task = byUrn.get(node.id);
      const data: TaskNodeData = { task: task as TaskRecord, isCause: causeTaskUrn === task?.urn };
      return { id: node.id, type: "task", data, ...box };
    }
    const urn = node.id.slice(2);
    const data: DataNodeData = {
      urn,
      isOrigin: originDataset === urn,
      columns: originDataset === urn ? (origin?.columns ?? null) : null,
      external: !writers.has(urn),
    };
    return { id: node.id, type: "data", data, ...box };
  });

  const edges: Edge[] = placed.edges.map((edge) => {
    // `lit` is keyed on exactly this id spelling. A test asserts the two agree,
    // because a mismatch would unlight the whole cascade with nothing to show it.
    const isLit = lit[edge.id] !== undefined;
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      // The moving dash, for as long as the marks stand.
      animated: isLit,
      style: { stroke: isLit ? STALE : "var(--mm-rose-line)", strokeWidth: isLit ? 2 : 1 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: isLit ? STALE : "var(--mm-rose-line)",
      },
    };
  });

  return { nodes, edges };
}

interface LineageProps {
  tasks: TaskRecord[];
  /** Opening a task's details. Datasets are not selectable; they carry no mark. */
  onSelect?: (urn: string) => void;
}

/**
 * The provider is what lets the canvas below call `fitView` for itself.
 *
 * `useReactFlow` reads a context that `<ReactFlow>` publishes, so a component
 * cannot both render the flow and use the hook. Splitting the two is React
 * Flow's own answer to that, and it is the whole reason this wrapper exists.
 */
export function Lineage(props: LineageProps) {
  return (
    <ReactFlowProvider>
      <LineageCanvas {...props} />
    </ReactFlowProvider>
  );
}

function LineageCanvas({ tasks, onSelect }: LineageProps) {
  const origin = currentChange(tasks);

  /*
   * React Flow owns the nodes and edges, and they are replaced only when the
   * picture genuinely changed.
   *
   * This was a `useMemo` keyed on `[tasks, origin]`, which are both rebuilt by
   * every poll. That handed React Flow a brand-new array once a second, and each
   * one restarted node measurement, so `handleBounds` never settled and the board
   * drew nine boxes with no edges between them.
   *
   * The signature is what makes it stop: an unchanged second produces the same
   * string, the effect returns early, and React Flow's own state is left
   * untouched. Measurement completes once and stays completed. It also means the
   * cascade animation runs continuously, because the `<path>` elements are never
   * replaced underneath it.
   */
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Read and written only inside the effect below. Reading a ref during render is
  // what `react-hooks/refs` forbids, and this deliberately does not.
  const lastSignature = useRef<string | null>(null);
  const signature = graphSignature(tasks, origin);

  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    const built = buildGraph(tasks, origin);
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [signature, tasks, origin, setNodes, setEdges]);

  /*
   * Re-frame the graph. The `fitView` prop below does this exactly once, on
   * mount, and never again, which is the bug this exists to close.
   *
   * Three things move the picture out of its frame after that one fit:
   *
   * - **The panel resizes.** It is 320px tall with a 220px floor, so a short
   *   viewport shrinks it, and the guide panel above changes height as the demo
   *   moves between stages.
   * - **The graph's own content grows.** The changed table's node goes from 56px
   *   to 84px when the column diff appears, so dagre lays the whole thing out
   *   taller and the bounds obsel fitted are no longer the bounds it is drawing.
   * - **Hot reload**, which is how this was found: React Flow kept a transform
   *   computed against a 648px panel while the panel became 266px.
   *
   * The failure is total rather than cosmetic. The panel clips its overflow and
   * `LOCKED` turns off pan and zoom, so a stranded graph cannot be dragged back:
   * it is nine boxes and eight edges present in the DOM, correct in every
   * respect, and entirely below the visible area. A lineage graph showing
   * nothing.
   *
   * `useNodesInitialized` is the wait that matters. Fitting before React Flow has
   * measured the new node sizes frames the previous layout, which is the same
   * class of mistake with a smaller error.
   */
  const { fitView } = useReactFlow();
  const measured = useNodesInitialized();
  const canvas = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!measured) return;
    void fitView(FIT);
  }, [measured, signature, fitView]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      void fitView(FIT);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitView]);

  return (
    <div className={styles.canvas} ref={canvas}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={FIT}
        proOptions={{ hideAttribution: false }}
        onNodeClick={(_event, node) => {
          if (onSelect && node.type === "task") onSelect(node.id.slice(2));
        }}
        {...LOCKED}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className={styles.dots} />
      </ReactFlow>
    </div>
  );
}

/** Exported for tests: the node id spellings the cascade and the layout share. */
export { dataNodeId, taskNodeId };
