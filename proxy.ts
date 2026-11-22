import { NextResponse, type NextRequest } from "next/server";
import { accessGate } from "./src/server/access-gate.ts";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";

/** Runs for every page and API request except the build's static files.
 *
 *  1. API methods keep the existing policy: the desktop capability, or in
 *     browser-only mode the Host check and the cross-site check on writes.
 *     That covers SSE and the spending/settings routes.
 *  2. The sign-in gate (access-gate.ts) then decides pages and APIs alike.
 *     It does nothing in desktop mode, and nothing on a machine that has no
 *     password and is reached directly.
 *
 * The one streamed document route is exempt from this proxy (below), so it
 * enforces both policies itself, avoiding Next's silently truncated Proxy body
 * clone. No public callback or worker bypass: legitimate self-HTTP still needs
 * the capability. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (pathname === "/api" || pathname.startsWith("/api/")) {
		const refusal = apiRequestRefusal(request);
		if (refusal) {
			return NextResponse.json(
				{ error: refusal },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
	}
	const { refusal, refreshCookie } = accessGate(request);
	if (refusal) return refusal;
	const response = NextResponse.next();
	if (refreshCookie) response.headers.append("set-cookie", refreshCookie);
	return response;
}

export const config = {
	// Everything except the build's static files and the exact streamed
	// document endpoint (not its subtree or other plugin routes). Must remain
	// a static literal.
	matcher: ["/((?!_next/static|api/plugins/[^/]+/documents/markdown/?$).*)"],
};
