import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, menuAnchorRect, type MenuSide } from "../components/menu-shell.tsx";

/**
 * The shared menu shell's placement decision (fix wave chunk B): the
 * pure math behind every dropdown's anchoring — side preference, the
 * honest-fit flip, the 60vh cap, alignment. The DOM effects (portal,
 * measure-then-show, re-placement on scroll/resize) are live-verified;
 * this pins the geometry.
 */

const rect = (top: number, bottom: number) => ({ top, bottom, left: 100, right: 300 });
const viewport = (height: number) => ({ width: 1280, height });

describe("computeMenuPlacement — side", () => {
	it("keeps the preferred side when it shows the whole menu", () => {
		for (const preferred of ["up", "down"] as MenuSide[]) {
			const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, preferred, "right");
			assert.equal(p.side, preferred);
		}
	});

	it("flips when the preferred side cannot hold the content and the other is roomier", () => {
		// Anchor 30px above the viewport bottom: down has ~2px of room,
		// up has ~380. A 300px menu must flip UP despite preferring down.
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 300, "down", "right");
		assert.equal(p.side, "up");
		// ...and mirrors: an anchor at the very top preferring up flips down.
		const q = computeMenuPlacement(rect(0, 30), viewport(800), 300, "up", "right");
		assert.equal(q.side, "down");
	});

	it("stays put when neither side fits better (the roomier side already preferred)", () => {
		// Short viewport: down has 450, up has 200 — a 600px menu stays
		// down (capped gracefully) because up is NOT roomier.
		const p = computeMenuPlacement(rect(150, 190), viewport(650), 600, "down", "right");
		assert.equal(p.side, "down");
	});

	it("nothing measured yet (contentHeight ≤ 0) keeps the preferred side", () => {
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 0, "down", "right");
		assert.equal(p.side, "down");
	});
});

describe("computeMenuPlacement — cap + position", () => {
	it("caps at 60vh when the side has more room than that", () => {
		// Anchor high: 648px below it — more than 60vh(480) → the cap is 60vh.
		const p = computeMenuPlacement(rect(100, 140), viewport(800), 300, "down", "right");
		assert.equal(p.maxHeight, 0.6 * 800);
		assert.equal(p.style.top, 144); // anchor bottom + GAP(4)
		assert.equal(p.style.right, 1280 - 300); // right-aligned to the anchor
	});

	it("caps at the side's available room when 60vh exceeds it", () => {
		// Anchor at 500/800: down room = 800 − 8 − 544 = 248 < 480. The
		// short content (100) fits down — no flip — so the cap binds at 248.
		const p = computeMenuPlacement(rect(500, 540), viewport(800), 100, "down", "right");
		assert.equal(p.side, "down");
		assert.equal(p.maxHeight, 248);
	});

	it("never crushes below the usability floor, even against a tiny side", () => {
		// Anchor 30px above the bottom, both sides thin: capped to the
		// floor, not a 2px sliver — the cap overflows rather than crushes.
		const p = computeMenuPlacement(rect(30, 60), viewport(90), 300, "down", "right");
		assert.equal(p.maxHeight, 96);
	});

	it("up-side menus anchor their BOTTOM above the anchor's top", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "up", "right");
		assert.equal(p.style.bottom, 800 - 400 + 4); // viewport − anchor.top − GAP
		assert.ok(!("top" in p.style));
	});

	it("left alignment keys off the anchor's left edge", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "down", "left");
		assert.equal(p.style.left, 100);
		assert.ok(!("right" in p.style));
	});
});
describe("computeMenuPlacement — a phone keyboard covering the bottom (mobile epic, story 5b)", () => {
	// 800px layout viewport; the keyboard covers the bottom 300, so 500px are visible.
	const covered = { width: 390, height: 800, hiddenBottom: 300 };
	it("room below the anchor ends where the keyboard starts", () => {
		// down room = 500 − 8 − (340 + 4) = 148, not the 448 an uncovered 800px screen would give
		const p = computeMenuPlacement(rect(300, 340), covered, 100, "down", "right");
		assert.equal(p.side, "down");
		assert.equal(p.maxHeight, 148);
	});
	it("a menu that only fits in the covered strip goes up instead", () => {
		const p = computeMenuPlacement(rect(300, 340), covered, 250, "down", "right");
		assert.equal(p.side, "up", "250px fits above (288) and not below (148)");
	});
	it("the 60% cap is of what can be seen", () => {
		const p = computeMenuPlacement(rect(10, 40), covered, 600, "down", "right");
		assert.equal(p.maxHeight, 0.6 * 500);
	});
	it("an up menu is still anchored from the bottom of the layout viewport, which the keyboard does not move", () => {
		const p = computeMenuPlacement(rect(400, 440), covered, 100, "up", "right");
		assert.equal(p.style.bottom, 800 - 400 + 4);
	});
	it("no keyboard, or none given: exactly as before", () => {
		const plain = computeMenuPlacement(rect(10, 40), { width: 390, height: 800 }, 100, "down", "right");
		assert.deepEqual(computeMenuPlacement(rect(10, 40), { width: 390, height: 800, hiddenBottom: 0 }, 100, "down", "right"), plain);
		assert.equal(plain.maxHeight, 0.6 * 800);
	});
});
describe("menuAnchorRect — the anchor seam", () => {
	const doc = { querySelector: () => ({ getBoundingClientRect: () => ({ top: 1, bottom: 2, left: 3, right: 4 }) }) } as unknown as Pick<Document, "querySelector">;
	it("prefers a virtual anchor rect when it yields one", () => {
		assert.deepEqual(menuAnchorRect({ getAnchorRect: () => ({ top: 10, bottom: 20, left: 30, right: 40 }), anchorTestid: "x" }, doc), { top: 10, bottom: 20, left: 30, right: 40 });
	});
	it("falls back to the element seam when the virtual anchor is gone", () => {
		assert.deepEqual(menuAnchorRect({ getAnchorRect: () => null, anchorTestid: "x" }, doc), { top: 1, bottom: 2, left: 3, right: 4 });
	});
	it("is null with no anchor at all", () => {
		assert.equal(menuAnchorRect({}, doc), null);
	});
});
