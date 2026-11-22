"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";

/** Sign-out controls for the hosted server. Shown only when the server has a
 * password; on a computer's own server (and in the desktop app) they don't exist. */
export function AccessSettings() {
	const [enabled, setEnabled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const res = await fetch("/api/access");
				const body = res.ok ? ((await res.json()) as { enabled?: boolean }) : null;
				if (live && body?.enabled === true) setEnabled(true);
			} catch { /* an older server, or signed out: no controls */ }
		})();
		return () => { live = false; };
	}, []);
	if (!enabled) return null;

	const signOutEverywhere = async () => {
		setBusy(true);
		setFailed(false);
		try {
			const res = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign-out-all" }) });
			if (!res.ok) throw new Error(String(res.status));
			window.location.assign("/login");
		} catch {
			setFailed(true);
			setBusy(false);
		}
	};

	return (
		<>
			<SettingsRow label="Sign out" hint="Ends the session on this device." testid="row-sign-out">
				<form method="post" action="/logout">
					<Button type="submit" size="xs" variant="outline" className="relative touch-target cursor-pointer" data-testid="sign-out">Sign out</Button>
				</form>
			</SettingsRow>
			<SettingsRow
				label="Sign out of all devices"
				hint={failed ? <span role="alert">Could not sign out. Try again.</span> : "Ends every session, phones and computers alike. Your password is needed again."}
				testid="row-sign-out-all"
			>
				<Button type="button" size="xs" variant="outline" className="relative touch-target cursor-pointer disabled:cursor-not-allowed" disabled={busy} aria-busy={busy} data-testid="sign-out-all" onClick={() => void signOutEverywhere()}>Sign out everywhere</Button>
			</SettingsRow>
		</>
	);
}
