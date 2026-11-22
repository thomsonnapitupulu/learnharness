/**
 * POST /api/uploads?name=<file name>, the file as the request body. The reply
 * is { id, name, size, path }: the path is what the message carries.
 *
 * This route is exempt from proxy.ts, because Next hands the proxy a copy of a
 * body that it cuts off at 25 MiB (see the matcher there). So it does the
 * proxy's two checks itself, before reading anything, exactly as the streamed
 * document route does: the API policy (host and cross-site writes, or the
 * desktop capability), then the sign-in gate.
 */

import { MAX_UPLOAD_BYTES, uploadTooLargeMessage } from "../../lib/upload-limits.ts";
import { accessGate } from "./access-gate.ts";
import { apiRequestRefusal } from "./desktop-access.ts";
import { safeUploadName, saveUpload, sweepUploads, UploadError } from "./uploads.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

function refusal(request: Request): Response | undefined {
	const error = apiRequestRefusal(request);
	return error ? json({ error }, 403) : accessGate(request).refusal;
}

/** Uploads are the only thing that can leave an orphan, so they are also what
 * tidies up: at most once in six hours, in the background. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

export function createUploadRoute({ save = saveUpload, sweep = () => sweepUploads() }: { save?: typeof saveUpload; sweep?: () => Promise<number> } = {}) {
	let lastSweep = 0;
	const sweepSometimes = (now: number = Date.now()) => {
		if (now - lastSweep < SWEEP_EVERY_MS) return;
		lastSweep = now;
		sweep().then(
			(removed) => { if (removed > 0) console.info(`[uploads] removed ${removed} old upload(s) that no session mentions`); },
			(error) => console.warn(`[uploads] sweep failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	};
	const unsupported = (request: Request) => refusal(request) ?? new Response(null, { status: 405, headers: { Allow: "OPTIONS, POST" } });
	return {
		async POST(request: Request): Promise<Response> {
			const denied = refusal(request);
			if (denied) return denied;
			const name = new URL(request.url).searchParams.get("name");
			// Refuse a declared size at once, without reading the body. The bytes
			// that really arrive are counted as well: this header can lie.
			const declared = Number(request.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return json({ error: uploadTooLargeMessage(safeUploadName(name)) }, 413);
			try {
				const saved = await save(request.body, name);
				sweepSometimes();
				return json({ id: saved.id, name: saved.name, size: saved.size, path: saved.path }, 201);
			} catch (error) {
				if (error instanceof UploadError) return json({ error: error.message }, error.status);
				throw error;
			}
		},
		OPTIONS: (request: Request) => refusal(request) ?? new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
		GET: unsupported,
		HEAD: unsupported,
		PUT: unsupported,
		PATCH: unsupported,
		DELETE: unsupported,
	};
}

export const uploadRoute = createUploadRoute();
