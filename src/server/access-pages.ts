/**
 * The sign-in and sign-out pages: plain HTML, no script, no app shell, so
 * nothing from the chats loads before sign-in. Colors are the Default theme's
 * (dark), with a light variant for phones set to light.
 */

export const PAGE_HEADERS: Record<string, string> = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"X-Content-Type-Options": "nosniff",
	// Not "no-referrer": a browser then sends "Origin: null" with the form's POST,
	// which the same-origin check rightly refuses. "same-origin" keeps the real one.
	"Referrer-Policy": "same-origin",
};

export function escapeHTML(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root{--bg:#141414;--fg:#e6e6e6;--card:#1c1c1c;--muted:#8d8d8d;--line:#434343;--err:#ef4444;color-scheme:dark light}
@media (prefers-color-scheme:light){:root{--bg:#f5f5f3;--fg:#1a1a1a;--card:#fff;--muted:#6b6b6b;--line:#d4d4d0;--err:#c0392b}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:max(1.5rem,env(safe-area-inset-top)) max(1.5rem,env(safe-area-inset-right)) max(1.5rem,env(safe-area-inset-bottom)) max(1.5rem,env(safe-area-inset-left));background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:22rem}
h1{margin:0 0 .25rem;font:700 1.5rem/1.2 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:-.01em}
p{margin:0 0 1.25rem;color:var(--muted)}
p.err{color:var(--err)}
form{display:grid;gap:.75rem}
input,button{width:100%;height:3rem;font:inherit;border-radius:.6rem}
input{padding:0 .9rem;color:inherit;background:var(--card);border:1px solid var(--line)}
button,a.btn{font-weight:600;color:var(--bg);background:var(--fg);border:0;cursor:pointer}
a.btn{display:grid;place-items:center;height:3rem;border-radius:.6rem;text-decoration:none}
input:focus-visible,button:focus-visible,a.btn:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);opacity:0}
`;

function shell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta name="robots" content="noindex">
<title>${escapeHTML(title)} · LearnHarness</title>
<style>${STYLE}</style></head><body><main>
<h1>LearnHarness</h1>
${body}
</main></body></html>`;
}

/** `locked` hides the form: nothing to type until the lock is cleared. With an
 * address set up (`canEmail`) it offers a button that emails an unlock link. */
export function loginPage({ next = "/", message = "", locked = false, canEmail = false }: { next?: string; message?: string; locked?: boolean; canEmail?: boolean } = {}): string {
	return shell("Sign in", `<p>Sign in to continue.</p>
${message ? `<p class="err" role="alert">${escapeHTML(message)}</p>` : ""}
${locked ? (canEmail ? `<form method="post" action="/unlock"><button type="submit">Email me an unlock link</button></form>` : "") : `<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHTML(next)}">
<input class="hidden" type="text" name="username" value="owner" autocomplete="username" tabindex="-1" aria-hidden="true">
<input type="password" name="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Password" placeholder="Password" required autofocus>
<button type="submit">Sign in</button>
</form>`}`);
}

export function signedOutPage(message = ""): string {
	return shell("Sign out", `${message ? `<p class="err" role="alert">${escapeHTML(message)}</p>` : "<p>Sign out of this device?</p>"}
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`);
}

/** The page an emailed link opens. It asks first: a mail scanner that previews
 * the link must not unlock anything. */
export function unlockPage(token: string): string {
	return shell("Unlock", `<p>Sign-in is locked after too many wrong passwords. Unlock it?</p>
<form method="post" action="/unlock"><input type="hidden" name="token" value="${escapeHTML(token)}"><button type="submit">Unlock</button></form>`);
}

export function unlockedPage(): string {
	return shell("Unlocked", `<p>Sign-in is unlocked.</p>
<a class="btn" href="/login">Go to sign in</a>`);
}

export function unlockFailedPage(message = "This unlock link has expired or was already used. Open the sign-in page to ask for a new one."): string {
	return shell("Unlock", `<p class="err" role="alert">${escapeHTML(message)}</p>
<a class="btn" href="/login">Go to sign in</a>`);
}

export function notSetUpPage(): string {
	return shell("Sign in", `<p>Sign-in is not set up on this server. On the server, run <code>npm run access -- set-password</code>.</p>`);
}

/** At most `limit` bytes of an urlencoded form, or null. */
export async function readForm(request: Request, limit = 4096): Promise<URLSearchParams | null> {
	if (Number(request.headers.get("content-length") ?? 0) > limit || !request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function html(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

export function redirect(location: string, headers: Record<string, string | string[]> = {}): Response {
	const response = new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
	for (const [name, value] of Object.entries(headers)) for (const v of [value].flat()) response.headers.append(name, v);
	return response;
}
