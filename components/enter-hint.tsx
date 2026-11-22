import { cn } from "@/lib/utils";

/** The line beside a Submit button that says what Enter does: it sends on a
 * computer's keyboard and is a newline on an on-screen one (lib/touch-keyboard.ts).
 * Both are rendered and CSS shows the one that is true, so the server render
 * and the first client render agree. */
export function EnterHint({ className }: { className?: string }) {
	return (
		<span aria-hidden className={cn("pl-1.5 text-xs text-muted-foreground", className)}>
			<span className="pointer-coarse:hidden">↵ submits · ⇧↵ newline</span>
			<span className="hidden pointer-coarse:inline">↵ new line</span>
		</span>
	);
}
