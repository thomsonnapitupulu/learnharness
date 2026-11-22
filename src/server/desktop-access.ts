import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** Browser-only mode: `next dev` / `next start` without the desktop shell's
 * per-launch secret. */
export function browserOnlyMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_DESKTOP_SERVER !== "1" && !env.LH_DESKTOP_API_SECRET;
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is checked by
 * browserAPIRefusal instead. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (browserOnlyMode(env)) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** The scheme the browser used. Behind a TLS-terminating proxy (Caddy on the
 * hosted server) the request URL says http while the browser spoke https, so
 * X-Forwarded-Proto is trusted for the scheme and nothing else: the host
 * always comes from Host. */
export function requestProtocol(request: Request): "http:" | "https:" {
	const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
	if (forwarded === "https") return "https:";
	if (forwarded === "http") return "http:";
	return new URL(request.url).protocol === "https:" ? "https:" : "http:";
}

/** Same-origin browser controls, not user authentication (that is
 * access-gate.ts). Never trust a forwarded host or add CORS grants here. */
export function subscriptionRequestOrigin(request: Request): string | undefined {
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? url.host;
		const addressed = new URL(`${requestProtocol(request)}//${host}`);
		if (!["http:", "https:"].includes(addressed.protocol) || addressed.username || addressed.password || addressed.pathname !== "/" || addressed.search || addressed.hash) return;
		return addressed.origin;
	} catch { return; }
}

/** DNS rebinding needs an attacker-owned DNS name, so localhost names and IP
 * literals are always safe. Any other name must be listed in LH_ALLOWED_HOSTS
 * (comma-separated, case-insensitive, port ignored). */
export function browserHostAllowed(host: string | null, env: Record<string, string | undefined> = process.env): boolean {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
	const allowed = (env.LH_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(hostname);
}

/** Shared by Proxy and the streamed document route that deliberately bypasses
 * Proxy's truncated body clone. Check before any route-specific work. */
export function apiRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (browserOnlyMode(env)) return browserAPIRefusal(request, env);
	if (!desktopAPIAuthorized(request.headers, env)) return "Desktop API access requires the trusted LearnHarness window.";
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Browser-only API gate: a Host check against DNS rebinding and a
 * cross-site check on writes. Writes without Origin or Sec-Fetch-Site come
 * from non-browser clients and are allowed. Returns the refusal, if any. */
export function browserAPIRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (!browserHostAllowed(request.headers.get("host") ?? new URL(request.url).host, env)) {
		return "This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS.";
	}
	if (READ_METHODS.has(request.method.toUpperCase())) return;
	if (crossSiteWrite(request)) return "Cross-site requests to the LearnHarness API are not allowed.";
}

/** A write another site or an opaque origin sent. Requests without Origin or
 * Sec-Fetch-Site come from non-browser clients and are not cross-site. */
export function crossSiteWrite(request: Request): boolean {
	const site = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	return (site !== null && site !== "same-origin") || (origin !== null && origin !== subscriptionRequestOrigin(request));
}
