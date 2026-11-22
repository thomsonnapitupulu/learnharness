"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { FileSymlinkIcon, XIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { uploadFiles } from "@/lib/upload-client";

export const BROWSER_NOTICE = "Local file paths can only be attached in the desktop app. You can paste a full path instead.";

/** The content area only: the sidebar is deliberately outside this zone.
 * In the desktop app, existing files stay where they are and only quoted path
 * strings enter drafts. In a browser a dropped file has no path the server can
 * read, so it is uploaded and the path it is saved under enters the draft. */
export function FilePathDropZone({ children, className, onContentRoot }: {
	children: React.ReactNode;
	className?: string;
	onContentRoot?: (element: HTMLElement | null) => void;
}) {
	const root = useRef<HTMLElement>(null);
	useEffect(() => {
		onContentRoot?.(root.current);
		return () => { onContentRoot?.(null); };
	}, [onContentRoot]);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [notice, setNotice] = useState("");
	const sendingNow = useRef<AbortController | null>(null);
	// This zone lives in the app shell, so it outlasts a change of page. Leaving
	// the page mid-upload stops it: the paths would land in another session's
	// composer.
	const pathname = usePathname();
	useEffect(() => () => sendingNow.current?.abort(), [pathname]);
	const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
	const clearDrag = () => { depth.current = 0; setDragging(false); };
	useEffect(() => {
		// The sidebar remains a non-target, but dropping a file there must not
		// navigate the app away. No indicator or attachment is produced there.
		const preventOutsideNavigation = (event: DragEvent) => {
			if (Array.from(event.dataTransfer?.types ?? []).includes("Files")
				&& event.target instanceof Node && !root.current?.contains(event.target)) event.preventDefault();
		};
		window.addEventListener("dragover", preventOutsideNavigation);
		window.addEventListener("drop", preventOutsideNavigation);
		return () => {
			window.removeEventListener("dragover", preventOutsideNavigation);
			window.removeEventListener("drop", preventOutsideNavigation);
		};
	}, []);
	/** Where dropped paths go: the focused editor's caret, else the page's own
	 * input. Says why not when there is neither. */
	const place = (paths: string[]): string => {
		const focused = document.activeElement?.closest<HTMLElement>("[data-file-path-input]");
		if (focused && root.current?.contains(focused)) {
			focused.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			return "";
		}
		return appendToPrimaryInput(paths.map(quoteFilePath).join(" ")) ? "" : "Open a chat to attach file paths.";
	};
	/** Browser drop: upload the files (never folders), then place their server paths. */
	const attachUploads = async (files: File[], folders: boolean) => {
		if (files.length === 0) { setNotice(folders ? "Folders cannot be uploaded. Drop files instead." : "No files were dropped."); return; }
		if (sendingNow.current && !sendingNow.current.signal.aborted) { setNotice("Wait for the upload that is running to finish."); return; }
		const controller = (sendingNow.current = new AbortController());
		const { signal } = controller;
		const progress = (index: number, fraction: number) => setNotice(
			`Uploading ${files.length === 1 ? files[0]!.name : `file ${index + 1} of ${files.length}`}… ${Math.round(fraction * 100)}%`);
		const { paths, errors } = await uploadFiles(files, { signal, onProgress: progress });
		if (sendingNow.current === controller) sendingNow.current = null;
		if (signal.aborted) { setNotice(""); return; }
		const problems = [...errors, ...(folders ? ["Folders cannot be uploaded, so only the files were attached."] : [])];
		const refusal = paths.length > 0 ? place(paths) : "";
		setNotice([refusal, ...problems].filter(Boolean).join("\n"));
	};
	return (
		<main
			ref={root}
			className={className}
			data-testid="file-path-drop-zone"
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				depth.current++;
				setDragging(true);
				setNotice("");
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDragging(false);
			}}
			onDragEnd={clearDrag}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.stopPropagation();
				clearDrag();
				const resolve = window.lh?.getPathForFile;
				// Inspect only the dropped item's type, never traverse its entries.
				// Positively known directories get a durable trailing separator.
				const entries = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
				if (!resolve) {
					const dropped = Array.from(event.dataTransfer.files);
					const isFolder = (index: number) => { try { return entries[index]?.webkitGetAsEntry?.()?.isDirectory === true; } catch { return false; } };
					const folders = dropped.map((_, index) => isFolder(index));
					void attachUploads(dropped.filter((_, index) => !folders[index]), folders.includes(true));
					return;
				}
				const paths: string[] = [];
				let skipped = 0;
				for (const [index, file] of Array.from(event.dataTransfer.files).entries()) {
					try {
						let directory = false;
						try { directory = entries[index]?.webkitGetAsEntry?.()?.isDirectory === true; }
						catch { /* Unknown type stays unmarked, not guessed. */ }
						const original = resolve(file);
						const path = directory ? directoryReferencePath(original) : original;
						quoteFilePath(path); // Same rooted-path validity rule as typed chips.
						paths.push(path);
					} catch { skipped++; }
				}
				if (paths.length === 0) {
					setNotice("No local file paths were available. Drop existing files or folders from your computer.");
					return;
				}
				const refusal = place(paths);
				setNotice(refusal || (skipped ? "Some dropped items had no available file path." : ""));
			}}
		>
			{children}
			{dragging && (
				<div data-testid="file-path-drop-indicator" className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 p-6 text-center backdrop-blur-sm">
					<div className="flex max-w-md flex-col items-center gap-3">
						<FileSymlinkIcon className="size-8 text-primary" aria-hidden />
						<span className="font-ui text-sm">{window.lh?.getPathForFile ? "Drop to attach file paths" : "Drop to attach files"}</span>
					</div>
				</div>
			)}
			{notice && <div role="status" className="absolute bottom-2 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border bg-card px-3 py-2 font-ui text-xs shadow-sm">
				<span className="whitespace-pre-line">{notice}</span>
				<button type="button" aria-label="Dismiss attachment notice" onClick={() => setNotice("")} className="shrink-0 rounded-sm p-1 hover:bg-accent"><XIcon className="size-3" aria-hidden /></button>
			</div>}
		</main>
	);
}
