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

import { useCallback, useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
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
import { flowEdgeIds } from "./graph/flow";
import { dataNodeId, layoutPositions, taskNodeId } from "./graph/positions";
import { CAMERA_MS, FLY_MS } from "./motion-tokens";
import { DataNode, TaskNode } from "./nodes";
import type { DataNodeData, TaskNodeData } from "./nodes";
import { currentChange } from "./timing";
import { STALE } from "./tone";
import type { ErasureState } from "@/src/server/coordinator/erasure";
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
 * - **Drag pans, the wheel zooms, pinch zooms.** The wheel used to be excluded
 *   deliberately, and the reason it was has gone: the board was a column on a
 *   page that scrolled, and a wheel that zoomed would have made that page
 *   unscrollable over its largest region. The page does not scroll any more —
 *   the canvas IS the page — so the wheel has nothing else to do, and it is the
 *   move a reader reaches for first. It also answers what the panel costs: the
 *   demo's layout is width-pinned, so a reader on a laptop who wants design-size
 *   labels now has the obvious gesture for them.
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
  zoomOnScroll: true,
  zoomOnPinch: true,
  zoomOnDoubleClick: false,
  /*
   * The wheel belongs to the graph now, so the page is told to keep its hands
   * off it. With the page pinned to the viewport there is nothing behind the
   * canvas for a wheel event to scroll anyway; this stops the browser's
   * overscroll behaviours from firing on top of the zoom.
   */
  preventScrolling: true,
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
function graphSignature(
  tasks: TaskRecord[],
  origin: StaleMark | null,
  coverage: CoverageMode,
): string {
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
    // Sorted, so a report re-read every five seconds with the same answers
    // produces the same string and the graph is not rebuilt for nothing.
    coverage === null ? null : [...coverage.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  ]);
}

/**
 * How the board is being read.
 *
 * `null` is the staleness board: amber where finished work went out of date.
 * A map is the erasure board: the same graph, the same positions, coloured by
 * what an erasure report says about each table. A table absent from the map was
 * not reached by that report, which the nodes render as its own state rather
 * than as an absence of colour.
 */
export type CoverageMode = ReadonlyMap<string, ErasureState> | null;

/** Pure: the swarm in, React Flow's nodes, edges and layout bounds out. */
function buildGraph(
  tasks: TaskRecord[],
  origin: StaleMark | null,
  coverage: CoverageMode,
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

  /*
   * One string naming the cascade currently standing, or nothing.
   *
   * It is a React `key` and nothing else. The nodes use it to remount their
   * flare, which is what restarts a one-shot CSS animation on an element the
   * browser is otherwise reusing. `since` is on it as well as the dataset,
   * because the same table changing twice is two cascades and should flare
   * twice; a graph rebuilt for any other reason carries the same string and
   * flares not at all.
   */
  const ripple = origin === null ? null : `${origin.causedBy}|${origin.since}`;

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
      const data: TaskNodeData = {
        task: task as TaskRecord,
        isCause: causeTaskUrn === task?.urn,
        ripple,
        // No colour and no status word on the erasure board. `nodes.tsx` records
        // why an agent carries neither there.
        neutral: coverage !== null,
      };
      return { id: node.id, type: "task", data, ...box };
    }
    const urn = node.id.slice(2);
    const data: DataNodeData = {
      urn,
      isOrigin: originDataset === urn,
      columns: originDataset === urn ? (origin?.columns ?? null) : null,
      external: !writers.has(urn),
      // `undefined` off the erasure board, `null` on it for a table the report
      // did not reach. `nodes.tsx` records why those must stay distinguishable.
      coverage: coverage === null ? undefined : (coverage.get(urn) ?? null),
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
      style: {
        stroke: isLit ? STALE : "var(--mm-rose-line)",
        strokeWidth: isLit ? 2 : 1,
        /*
         * How far along the walk this edge is, as a custom property the
         * stylesheet turns into a delay.
         *
         * The hop count comes from `cascadeEdges`, which reads it off the marks
         * obsel wrote rather than re-deriving it from the shape of the graph.
         * That is the same rule the lighting itself keeps, and it matters as
         * much here: a stagger computed from topology would animate a path
         * through work obsel never marked, which is a claim the picture would be
         * making on its own.
         *
         * Set on every edge, lit or not, so the property always resolves. An
         * unlit edge runs no animation for it to affect.
         */
        ["--hop" as string]: isLit ? lit[edge.id] : 0,
      },
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

/*
 * `panelHeightFor` used to live here, and its removal is the redesign in one
 * function.
 *
 * It computed the panel height a layout needed at the width-decided zoom, and
 * the dashboard grew the graph panel to that number and let the whole PAGE scroll
 * to honour it. That was the right answer to the forty-task board clipping
 * inside a 320px panel, given a board that was a column of stacked rows.
 *
 * The canvas is the page now. It is already as tall as the frame, so there is no
 * height to negotiate and nothing for a report to tell the dashboard: a layout too
 * tall for the frame is panned and zoomed rather than scrolled to, which is what
 * the graph's own controls are for. The height report, the `graphHeight` state
 * it fed, and the `.cockpitTall` mode that state switched on all went together.
 */

/**
 * The class the flow animation hangs off.
 *
 * A plain global name rather than a CSS-module hash: React Flow puts this on its
 * own `.react-flow__edge` group, the stylesheet reaches it through `:global`
 * exactly as it reaches `.animated`, and a browser test can count the lit edges
 * without knowing a build-time hash.
 */
const FLOW_CLASS = "obselFlow";

interface LineageProps {
  tasks: TaskRecord[];
  /**
   * Opening a node's details: a task's own record, or a table's derived view.
   * The dashboard tells the two apart by the URN's entity type.
   */
  onSelect?: (urn: string) => void;
  /**
   * The pointer entering or leaving a node, by URN. Null means it left.
   *
   * The delay before this becomes a preview is the dashboard's, not the graph's:
   * this fires on every crossing, and `useHoverIntent` decides which crossings a
   * reader meant.
   */
  onHover?: (urn: string | null) => void;
  /**
   * Whose edges to draw as flowing, or null for none.
   *
   * Emphasis, never a claim. It says "these edges touch that box", which is
   * `reads` and `writes` restated, and deliberately not "a change went this
   * way" — that is the cascade, which is read off marks and keeps amber and its
   * own dash pattern so the two can never be mistaken for each other.
   */
  flowUrn?: string | null;
  /**
   * The URN whose details are open, so the graph can bring it into view.
   *
   * Not the same thing as the click that opened it. A reader can open a node,
   * pan away, zoom in, and still have its details on screen; and on the
   * forty-task board a node near the bottom-right is opened straight underneath
   * the card describing it. In both the card is talking about a box the reader
   * cannot see.
   */
  focus?: string | null;
  /** How the board is being read. See `CoverageMode`. */
  coverage?: CoverageMode;
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

function LineageCanvas({
  tasks,
  onSelect,
  onHover,
  flowUrn = null,
  focus,
  coverage = null,
}: LineageProps) {
  /*
   * No cascade on the erasure board.
   *
   * The lit path, the marching dash and the flares all say one thing: a change
   * travelled and put finished work out of date. That is a true statement about
   * the swarm and says nothing at all about whether anybody has accounted for a
   * subject's data, so on the erasure board there is no origin, no lit edge and
   * no amber anywhere. Two answers on one picture would leave a reader unsure
   * which question a colour was answering.
   */
  const origin = coverage === null ? currentChange(tasks) : null;

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
  const signature = graphSignature(tasks, origin, coverage);

  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    const built = buildGraph(tasks, origin, coverage);
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [signature, tasks, origin, coverage, setNodes, setEdges]);

  /*
   * Which edges are drawn as flowing, updated in place.
   *
   * Declared after the rebuild above so that a poll which genuinely changed the
   * picture rebuilds first and is re-marked in the same commit, rather than
   * losing the highlight for a frame.
   *
   * Three things this deliberately does NOT do. It does not enter
   * `graphSignature`, so pointing at a box never rebuilds the graph or restarts
   * node measurement. It returns the same object for an edge whose class did not
   * change, so React Flow's memoised edges re-render only the handful that did
   * — on the forty-task board a hover touches two to nine of eighty-two. And it
   * skips any edge the cascade has lit: that edge is already saying something
   * stronger, in amber, and a second animation on top of it would put two
   * claims on one line.
   */
  useEffect(() => {
    const inFlow = flowEdgeIds(tasks, flowUrn);
    setEdges((previous) => {
      let changed = false;
      const next = previous.map((edge) => {
        const wanted = inFlow.has(edge.id) && edge.animated !== true;
        if (wanted === (edge.className === FLOW_CLASS)) return edge;
        changed = true;
        return {
          ...edge,
          className: wanted ? FLOW_CLASS : undefined,
          style: {
            ...edge.style,
            stroke: wanted ? "var(--mm-rose)" : "var(--mm-rose-line)",
            strokeWidth: wanted ? 1.5 : 1,
          },
        };
      });
      return changed ? next : previous;
    });
  }, [flowUrn, signature, tasks, setEdges]);

  /*
   * Re-frame the graph. The `fitView` prop below does this exactly once, on
   * mount, and never again, which is the bug this exists to close.
   *
   * Three things move the picture out of its frame after that one fit:
   *
   * - **The canvas resizes.** It is whatever the frame has left after the panel,
   *   so moving the panel, dragging its edge, collapsing it or resizing the
   *   window all change the width the graph is fitted to.
   * - **The graph's own content grows.** The changed table's node goes from 56px
   *   to 84px when the column diff appears, so dagre lays the whole thing out
   *   taller and the bounds obsel fitted are no longer the bounds it is drawing.
   * - **Hot reload**, which is how this was found: React Flow kept a transform
   *   computed against a 648px panel while the panel became 266px.
   *
   * The failure is total rather than cosmetic: the region clips its overflow, so
   * a stranded graph is nine boxes and eight edges present in the DOM, correct
   * in every respect, and entirely outside the visible area. A lineage graph
   * showing nothing.
   *
   * `useNodesInitialized` is the wait that matters. Fitting before React Flow has
   * measured the new node sizes frames the previous layout, which is the same
   * class of mistake with a smaller error.
   */
  const { fitView, getNode, getZoom, setCenter, flowToScreenPosition } = useReactFlow();
  const measured = useNodesInitialized();
  const canvas = useRef<HTMLDivElement | null>(null);
  /*
   * The first fit is a cut and every one after it is a move.
   *
   * Travelling the opening fit would mean the board's first appearance is an
   * animation of the graph settling into frame, which is a performance rather
   * than a reading. After that, a re-fit that jumped would leave a reader
   * wondering whether they are looking at the same board reframed or a different
   * board; the travel is what answers that without a caption.
   */
  const fitted = useRef(false);
  const still = useReducedMotion() === true;
  const framing = useCallback(
    () => (fitted.current && !still ? { ...FIT, duration: CAMERA_MS } : FIT),
    [still],
  );

  useEffect(() => {
    if (!measured) return;
    void fitView(framing());
    fitted.current = true;
  }, [measured, signature, fitView, framing]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      void fitView(framing());
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitView, framing]);

  /*
   * Bring the open node into view, and only when it is not already there.
   *
   * The condition is the whole of it. Flying on every selection would yank the
   * picture out from under a reader who clicked a box they were already looking
   * at, which is nearly every click on the four-task board. This moves for the
   * two cases where the card genuinely describes something the reader cannot
   * see: a node outside the visible canvas, and a node underneath the details
   * card itself, which on the forty-task board is where a click near the
   * bottom-right corner lands.
   *
   * The zoom is left exactly as the reader set it. Framing is obsel's business;
   * how close to look is theirs.
   */
  useEffect(() => {
    if (!focus) return;
    const element = canvas.current;
    if (element === null) return;
    const node = getNode(taskNodeId(focus)) ?? getNode(dataNodeId(focus));
    if (node === undefined) return;

    const centre = {
      x: node.position.x + (node.measured?.width ?? 0) / 2,
      y: node.position.y + (node.measured?.height ?? 0) / 2,
    };
    const at = flowToScreenPosition(centre);
    const pane = element.getBoundingClientRect();
    // A margin, so a node hard against an edge counts as needing the move.
    const inside =
      at.x > pane.left + 48 &&
      at.x < pane.right - 48 &&
      at.y > pane.top + 48 &&
      at.y < pane.bottom - 48;
    // The corner the details card occupies; see `inspector-overlay.module.css`.
    const behindCard = at.x > pane.right - 400 && at.y > pane.bottom - 545;
    if (inside && !behindCard) return;

    void setCenter(centre.x, centre.y, {
      zoom: getZoom(),
      ...(still ? {} : { duration: FLY_MS }),
    });
  }, [focus, getNode, flowToScreenPosition, setCenter, getZoom, still]);

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
        onNodeMouseEnter={(_event, node) => onHover?.(node.id.slice(2))}
        onNodeMouseLeave={() => onHover?.(null)}
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
