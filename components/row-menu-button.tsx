"use client";

import { EllipsisIcon } from "lucide-react";
import type { MouseEvent } from "react";

/**
 * The "⋯" button at the right end of a sidebar row, shown on a touch screen only.
 *
 * A mouse opens a row's menu (Rename, Export, Delete) with a right click. A touch screen has no right click, and iOS
 * Safari sends no "contextmenu" event for a touch-and-hold either, so without this button those actions cannot be
 * reached on a phone. It opens the same menu, anchored to itself.
 *
 * It sits over the right end of the row, as a sibling of the row's own button (a button inside a button is not valid),
 * and the row leaves that end free with padding (`pointer-coarse:pr-12`). `hidden pointer-coarse:flex` keeps it out of
 * the way of a mouse entirely. The app draws no outline on focus anywhere (app/globals.css), so the button brings its
 * own ring, for a keyboard on a tablet.
 */
export function RowMenuButton({ label, open, testId, onClick }: {
	label: string;
	/** Whether this row's menu is open now. */
	open: boolean;
	testId: string;
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-expanded={open}
			data-testid={testId}
			onClick={onClick}
			className="absolute inset-y-0 right-0 hidden w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 pointer-coarse:flex"
		>
			<EllipsisIcon aria-hidden="true" className="size-4" />
		</button>
	);
}
