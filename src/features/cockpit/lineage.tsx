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
  Controls,
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
 * How far a reader may move the picture, and how far they may not.
 *
 * Interaction used to be off entirely: pan, zoom, drag and selection all offer
 * ways for the picture to end up somewhere other than where it was laid out,
 * and for a four-node graph that fits there was no upside. Forty tasks changed
 * the arithmetic. The whole graph fits at zoom 0.58, which puts a 13px label
 * on screen at 7.5px, so the fitted frame is an overview and the design-size
 * detail exists only if a reader can go and get it.
 *
 * So the reading moves are on and the editing moves stay off:
 *
 * - **Drag pans, pinch zooms.** The scroll wheel deliberately does NOT zoom:
 *   the tall board is on a page that scrolls, and a wheel that zooms wherever
 *   the graph happens to be under the cursor makes the page unscrollable over
 *   its largest region.
 * - **The zoom buttons and the fit button** (React Flow's own controls, drawn
 *   in obsel's tokens) are the mouse path to the same moves, and the fit
 *   button is the recovery: the old lock existed because a stranded graph had
 *   no way back, and now there is one on screen at all times.
 * - **Nodes cannot be dragged, connected or selected.** The layout is dagre's
 *   statement of the pipeline's shape, not a sketch to rearrange, and a node
 *   moved by hand would put the picture in disagreement with the record.
 */
const READING = {
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: false,
  panOnDrag: true,
  panOnScroll: false,
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomOnDoubleClick: false,
  preventScrolling: false,
} as const;

/**
 * The zoom range the viewport itself will hold, as distinct from the range
 * `fitView` may CHOOSE from (`FIT` below).
 *
 * These must be at least as wide as FIT's, and that is not decoration: React
 * Flow clamps the viewport to the instance range AFTER the fit is computed,
 * and the instance default floor is 0.5 — the exact clamp the forty-task board
 * originally clipped against. FIT.minZoom alone never fixed that, because a
 * fit option cannot go where the viewport is not allowed to follow; passing
 * the range to the instance is what makes the 0.2 backstop real.
 *
 * The ceiling is above FIT's 1.25 on purpose: fitting never enlarges past
 * design size, but a reader chasing a label is allowed to.
 */
const RANGE = { minZoom: 0.2, maxZoom: 1.5 } as const;

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
const FIT = {
  padding: 0.08,
  maxZoom: 1.25,
  /*
   * Far below React Flow's 0.5 default, which is a floor `fitView` CLAMPS at:
   * a layout needing 0.38 to fit rendered at 0.5, centred, cut off at the top
   * and bottom — found live the first time forty tasks were on the board. The
   * real fix is the panel growing to the layout (`panelHeightFor`); this floor
   * is the backstop that turns any future miscalculation into a small graph
   * instead of a clipped one, because a viewer can read small and cannot read
   * absent.
   */
  minZoom: 0.2,
} as const;

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

/** Pure: the swarm in, React Flow's nodes, edges and layout bounds out. */
function buildGraph(
  tasks: TaskRecord[],
  origin: StaleMark | null,
): { nodes: Node[]; edges: Edge[]; width: number; height: number } {
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

  return { nodes, edges, width: placed.width, height: placed.height };
}

/**
 * The panel height this layout needs to be shown WITHOUT clipping, at the zoom
 * the panel's width already decides.
 *
 * The demo's layout is wide and short, so its zoom is pinned by width and 320px
 * of panel has always been enough. The forty-task swarm is also TALL — ten
 * rows of boxes — and a fixed 320px panel forced `fitView` below its zoom
 * floor, where it clamps and centres: the graph rendered cut off at the top
 * and bottom, which is strictly worse than small. The fix direction is more
 * panel, never more shrinking: this computes the height the layout occupies at
 * the width-decided zoom, and the cockpit grows the panel (and lets the page
 * scroll) to honour it.
 */
export function panelHeightFor(
  layout: { width: number; height: number },
  panelWidth: number,
): number {
  if (layout.width <= 0 || layout.height <= 0 || panelWidth <= 0) return 0;
  const usable = panelWidth * (1 - 2 * FIT.padding);
  const zoom = Math.min(FIT.maxZoom, usable / layout.width);
  return Math.ceil((layout.height * zoom) / (1 - 2 * FIT.padding));
}

interface LineageProps {
  tasks: TaskRecord[];
  /**
   * Opening a node's details: a task's own record, or a table's derived view.
   * The cockpit tells the two apart by the URN's entity type.
   */
  onSelect?: (urn: string) => void;
  /**
   * The panel height the current layout needs at the current panel width, from
   * `panelHeightFor`. Reported whenever the graph or the panel width changes,
   * so the cockpit can grow the panel instead of letting `fitView` clip.
   */
  onNeededHeight?: (px: number) => void;
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

function LineageCanvas({ tasks, onSelect, onNeededHeight }: LineageProps) {
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

  // The layout's bounds, kept beside the nodes so the height report can be
  // recomputed on a plain resize without rebuilding the graph.
  const bounds = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    const built = buildGraph(tasks, origin);
    bounds.current = { width: built.width, height: built.height };
    setNodes(built.nodes);
    setEdges(built.edges);
    if (onNeededHeight && canvas.current) {
      onNeededHeight(panelHeightFor(bounds.current, canvas.current.clientWidth));
    }
  }, [signature, tasks, origin, setNodes, setEdges, onNeededHeight]);

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
      // Width first, fit second: a narrower panel changes the zoom, the zoom
      // changes the height the layout needs, and fitting before the panel has
      // grown to that height is exactly the clipped frame this exists to end.
      if (onNeededHeight && bounds.current) {
        onNeededHeight(panelHeightFor(bounds.current, element.clientWidth));
      }
      void fitView(FIT);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitView, onNeededHeight]);

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
          // Both kinds. Tables were unclickable until the board's "what tables?"
          // complaint made clear the abstraction needed somewhere to point: the
          // details panel is where a table stops being a box and becomes a file
          // with columns and a row count. The "t:"/"d:" prefix is stripped; the
          // URN itself says which kind of entity was chosen.
          if (onSelect) onSelect(node.id.slice(2));
        }}
        {...READING}
        {...RANGE}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className={styles.dots} />
        {/*
          React Flow's own zoom-in / zoom-out / fit-view buttons, restyled by
          `lineage.module.css` and otherwise stock: the alternative was three
          hand-rolled buttons doing what a shipped component already does.
          Top-right, because the key owns the bottom-left and the attribution
          the bottom-right. `showInteractive` off: that button toggles the
          editing lock, and the lock here is a decision, not a preference.
        */}
        <Controls position="top-right" showInteractive={false} fitViewOptions={FIT} />
      </ReactFlow>
    </div>
  );
}

/** Exported for tests: the node id spellings the cascade and the layout share. */
export { dataNodeId, taskNodeId };
