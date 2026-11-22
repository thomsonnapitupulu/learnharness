"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";

type ServerState = { mode: "local" | "remote"; address: string | null };

/** The desktop app's "Server" row: this computer's own copy of LearnHarness, or a
 * server you host (docs/mobile/desktop-server.md). Changing it asks the app for
 * a native confirmation and restarts it; nothing is copied between the two.
 * Only the desktop app has `window.lh.server`: everywhere else this renders nothing. */
export function ServerSettings() {
	const [state, setState] = useState<ServerState | null>(null);
	const field = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
	useEffect(() => {
		let live = true;
		void window.lh?.server?.get().then((next) => { if (live) setState(next); }).catch(() => { /* no row: the app cannot say */ });
		return () => { live = false; };
	}, []);
	if (!state) return null;

	const change = async (next: string | null) => {
		setBusy(true);
		setMessage(null);
		try {
			const result = await window.lh!.server!.set(next);
			if (result.ok) {
				setMessage({ text: "Restarting…", error: false }); // stays busy: the window is about to close
				return;
			}
			if (!result.cancelled) setMessage({ text: result.error ?? "The server could not be changed.", error: true });
		} catch {
			setMessage({ text: "The server could not be changed.", error: true });
		}
		setBusy(false);
	};

	const remote = state.mode === "remote";
	return (
		<SettingsRow
			label="Server"
			testid="row-server"
			hint={
				<>
					<span className="block [overflow-wrap:anywhere]" data-testid="server-state">
						{remote ? `Connected to ${state.address}. Your sessions and notes are stored there.` : "Using this computer. Your sessions and notes are stored here."}
					</span>
					{message && <span className={message.error ? "block text-error" : "block"} role={message.error ? "alert" : "status"} data-testid="server-message">{message.text}</span>}
				</>
			}
		>
			{remote ? (
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} aria-busy={busy} data-testid="server-use-computer" onClick={() => void change(null)}>
					Use this computer
				</Button>
			) : (
				<form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void change(field.current?.value ?? ""); }}>
					<input
						type="text"
						inputMode="url"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						aria-label="Server address"
						placeholder="learn.example.com"
						data-testid="server-address"
						ref={field}
						disabled={busy}
						className="h-7 w-52 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
					/>
					<Button type="submit" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} aria-busy={busy} data-testid="server-connect">
						Connect
					</Button>
				</form>
			)}
		</SettingsRow>
	);
}
