/** One uploaded file, from a browser to the server's disk (src/server/uploads.ts).
 * The browser refuses a bigger file before sending it; the server counts the
 * bytes it actually receives; Caddy's limit sits a little above this. */
export const MAX_UPLOAD_MIB = 64;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MIB * 1024 * 1024;

export function uploadTooLargeMessage(name: string): string {
	return `${name} is larger than ${MAX_UPLOAD_MIB} MiB, the most that can be attached.`;
}
