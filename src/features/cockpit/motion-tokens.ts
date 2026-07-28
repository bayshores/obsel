/**
 * mmux's curve and the one spring, in the form motion takes them.
 *
 * Both values were written out twice, in `guide-panel.tsx` and
 * `tour-panel.tsx`, with a comment in each asking the next reader to keep them
 * in step by hand. The dock and its tabs need the same two, which would have
 * made four copies of a pair of numbers whose whole purpose is that everything
 * on the board moves alike. So they live here and are imported.
 *
 * `EASE` is `--mm-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`) as the four numbers
 * motion wants. It is repeated from `globals.css` rather than read out of it
 * because these animations are driven in JavaScript and there is no way to ask
 * the stylesheet; if the token changes, this changes with it.
 */
export const EASE = [0.2, 0.8, 0.2, 1] as const;

/**
 * The one spring on the board, and it stays rare on purpose.
 *
 * Everything else is an instrument reading and moves on a fixed curve. A spring
 * is for a physical object being put down on the screen and picked back up: the
 * tour window, and now the dock, which a reader genuinely picks up and drops on
 * the other side. The small overshoot is what makes both read as objects rather
 * than as panels being redrawn.
 */
export const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.9 };

/**
 * How long a camera move takes, in seconds, for React Flow's viewport API.
 *
 * The graph used to jump between framings because the page it sat on was
 * scrolling and a moving viewport inside a moving page is unreadable. The page
 * no longer scrolls, so a fit can be travelled instead of cut, and travelling it
 * is what tells a reader the board they are looking at is the board they were
 * just looking at, reframed.
 */
export const CAMERA_MS = 400;

/** A fly-to is longer than a re-fit: it crosses more of the board. */
export const FLY_MS = 500;
