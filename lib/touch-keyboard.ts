import { useSyncExternalStore } from "react";

/**
 * Phones and tablets (mobile epic, story 5a): the main pointer is a finger, so
 * the keyboard is the on-screen one, and that has no Shift+Enter. In a field
 * that sends on Enter, a person on a phone then has no way to start a new line.
 * So there Enter is a newline and the send button sends; Cmd or Ctrl+Enter (a
 * keyboard attached to a tablet) still sends. On a computer nothing changes.
 *
 * Read when the key is pressed, not once, so a window that moves between a
 * touch screen and a mouse follows it.
 */
export function onScreenKeyboard(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** May this Enter press send? Always on a computer; with an on-screen keyboard only together with Cmd or Ctrl. */
export function enterMaySend(event: { metaKey?: boolean; ctrlKey?: boolean }): boolean {
	return event.metaKey || event.ctrlKey || !onScreenKeyboard();
}

/** The key press that asks a text field to send without anyone's keyboard (the
 * citation popover's "save and send" into a dock or side-question field):
 * Ctrl+Enter, so it sends on an on-screen keyboard too. */
export const SEND_KEY_INIT = { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true } as const;

function watchPointer(notify: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const query = window.matchMedia("(pointer: coarse)");
	query.addEventListener?.("change", notify);
	return () => query.removeEventListener?.("change", notify);
}

/** For text that has to say which key does what (a placeholder). The server
 * render and the first client render say "computer", then it follows the
 * device, so hydration never disagrees with the page. */
export function useOnScreenKeyboard(): boolean {
	return useSyncExternalStore(watchPointer, onScreenKeyboard, () => false);
}
