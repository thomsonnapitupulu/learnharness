import { MAX_UPLOAD_BYTES, uploadTooLargeMessage } from "./upload-limits.ts";

export type UploadResult = { ok: true; path: string } | { ok: false; error: string };

/** Sends one file to /api/uploads, reporting progress as bytes sent and bytes in
 * all. The answer is the file's path on the server, or a sentence for the
 * reader (every sentence names the file). XMLHttpRequest, not fetch: only it
 * reports upload progress. */
export function uploadFile(
	file: File,
	{ signal, onProgress }: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {},
): Promise<UploadResult> {
	if (file.size > MAX_UPLOAD_BYTES) return Promise.resolve({ ok: false, error: uploadTooLargeMessage(file.name) });
	return new Promise((resolve) => {
		const fail = (error: string) => resolve({ ok: false, error });
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `/api/uploads?name=${encodeURIComponent(file.name)}`);
		xhr.responseType = "json";
		xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
		xhr.onload = () => {
			const body = xhr.response as { path?: unknown; error?: unknown } | null;
			if (xhr.status === 201 && typeof body?.path === "string") return resolve({ ok: true, path: body.path });
			if (xhr.status === 401) return fail(`You were signed out. Sign in again, then attach ${file.name}.`);
			if (xhr.status === 413) return fail(uploadTooLargeMessage(file.name));
			// Node gives up on a request that is still arriving after 5 minutes (a 64 MiB file needs about 1.8 Mbit/s).
			if (xhr.status === 408) return fail(`${file.name} took longer than 5 minutes to send, so it was stopped. Try again on a faster connection, or with a smaller file.`);
			const said = typeof body?.error === "string" ? body.error : "";
			if (said) return fail(said.includes(file.name) ? said : `${file.name}: ${said}`);
			fail(`${file.name} could not be attached (error ${xhr.status}).`);
		};
		xhr.onerror = () => fail(`${file.name} could not be sent. Check the connection and try again.`);
		xhr.onabort = () => fail(`${file.name} was not attached.`);
		signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(file);
	});
}

/** Sends the files one after another. `onProgress` gets the file's position in
 * the list and how much of it is sent, from 0 to 1 (0 as each file starts). */
export async function uploadFiles(
	files: readonly File[],
	{ signal, onProgress }: { signal?: AbortSignal; onProgress?: (index: number, fraction: number) => void } = {},
): Promise<{ paths: string[]; errors: string[] }> {
	const batch = { paths: [] as string[], errors: [] as string[] };
	for (const [index, file] of files.entries()) {
		if (signal?.aborted) break;
		onProgress?.(index, 0);
		const result = await uploadFile(file, { signal, onProgress: (sent, total) => onProgress?.(index, total > 0 ? sent / total : 1) });
		if (result.ok) batch.paths.push(result.path);
		else batch.errors.push(result.error);
	}
	return batch;
}
