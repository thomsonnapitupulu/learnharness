import type { MetadataRoute } from "next";

/** What "Add to Home Screen" reads (mobile epic, story 4). Static: the app's
 * name, its icons and the dark default's colours. The gate lets it through
 * without a session (src/server/access-gate.ts PUBLIC_FILES): browsers fetch
 * the manifest without cookies. */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory: sessions, quizzes, and a knowledge graph of what you know.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
