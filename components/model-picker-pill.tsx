"use client";

import type { ComponentProps } from "react";

/** The core and controlled plugin pickers share the very same trigger renderer.
 * The name is cut with an ellipsis instead of wrapping when the row is tight (a 360px phone); a pill that must keep
 * its text (the thinking level) says `shrink-0`. */
export function ModelPickerPill({ children, className, ...props }: ComponentProps<"button">) {
	return <button type="button" {...props}
		className={`relative touch-target flex min-w-0 items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 font-ui text-xs shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted${className ? ` ${className}` : ""}`}>
		<span className="truncate text-card-foreground">{children}</span>
		<span aria-hidden className="text-xs text-muted-foreground">▾</span>
	</button>;
}
