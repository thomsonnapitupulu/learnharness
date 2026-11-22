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
export function enterMaySend(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
	return event.metaKey || event.ctrlKey || !onScreenKeyboard();
}
