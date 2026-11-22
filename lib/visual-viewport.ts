/**
 * The on-screen keyboard (mobile epic, story 5b). Phones do not shrink the page
 * for the keyboard: iOS and Chrome on Android shrink the *visual* viewport
 * (`window.visualViewport`) and leave the layout viewport alone, so whatever is
 * anchored to the bottom of the page, the composer and the answer docks, ends
 * up behind the keyboard.
 *
 * While a keyboard is up, two CSS variables on <html> say what is left:
 *   --lh-vvh      the visible height
 *   --lh-vv-top   how far the visible area has been panned down the layout viewport
 * and `html[data-lh-keyboard]` is set. The app shell takes its height and its
 * top from them (components/sidebar.tsx), so everything in it, the dock's
 * height budget included, simply fits above the keyboard. With no keyboard the
 * variables are unset and the shell is 100dvh at the top, as it was.
 *
 * `--lh-vv-top` is visualViewport.offsetTop, which is measured from the layout
 * viewport, so whatever uses it is `position: fixed` (the shell while a keyboard
 * is up, the side-question sheet): that stays right however the page has scrolled.
 */

/** Smaller differences are the browser's own bars, not a keyboard. */
export const KEYBOARD_MIN_PX = 100;

export interface ViewportReading {
	/** window.innerHeight: the layout viewport, which a keyboard does not change. */
	layoutHeight: number;
	/** visualViewport.height, offsetTop and scale. */
	height: number;
	offsetTop: number;
	scale: number;
}

/** The part of the screen a keyboard leaves visible, or null when there is no keyboard. A pinch-zoomed page also has
 * a smaller visual viewport, for another reason, so it counts as none. */
export function visibleArea(reading: ViewportReading): { height: number; top: number } | null {
	if (Math.abs(reading.scale - 1) > 0.01) return null;
	// The keyboard's size is how much shorter the visual viewport is than the layout viewport, wherever the page has
	// been panned to (offsetTop): iOS pans just far enough to show the focused field, which can still leave the
	// bottom of the page under the keyboard.
	if (reading.layoutHeight - reading.height < KEYBOARD_MIN_PX) return null;
	return { height: Math.round(reading.height), top: Math.round(reading.offsetTop) };
}

/** True while installVisualViewportVars says a keyboard is up. */
export const keyboardIsUp = (doc: Document) => doc.documentElement.hasAttribute("data-lh-keyboard");

/** How much of the bottom of the layout viewport a keyboard covers, in px (0 with no keyboard). Fixed pop-ups are
 * placed against the layout viewport, so they use this to stay above it. */
export function keyboardCover(win: Window = window): number {
	const viewport = win.visualViewport;
	if (!viewport || !keyboardIsUp(win.document)) return 0;
	return Math.max(0, Math.round(win.innerHeight - viewport.offsetTop - viewport.height));
}

/** Keeps the variables in step with the visual viewport, on a touch screen only. Returns the cleanup. */
export function installVisualViewportVars(win: Window = window): () => void {
	const viewport = win.visualViewport;
	if (!viewport || typeof win.matchMedia !== "function" || !win.matchMedia("(pointer: coarse)").matches) return () => {};
	const root = win.document.documentElement;
	let frame = 0;
	const clear = () => {
		root.style.removeProperty("--lh-vvh");
		root.style.removeProperty("--lh-vv-top");
		root.removeAttribute("data-lh-keyboard");
	};
	const apply = () => {
		frame = 0;
		const area = visibleArea({ layoutHeight: win.innerHeight, height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale });
		if (!area) return clear();
		root.style.setProperty("--lh-vvh", `${area.height}px`);
		root.style.setProperty("--lh-vv-top", `${area.top}px`);
		root.setAttribute("data-lh-keyboard", "");
	};
	const schedule = () => { if (!frame) frame = win.requestAnimationFrame(apply); };
	viewport.addEventListener("resize", schedule);
	viewport.addEventListener("scroll", schedule);
	apply();
	return () => {
		if (frame) win.cancelAnimationFrame(frame);
		viewport.removeEventListener("resize", schedule);
		viewport.removeEventListener("scroll", schedule);
		clear();
	};
}
