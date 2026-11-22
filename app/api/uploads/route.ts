import { uploadRoute } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This exact route skips Proxy (its body copy stops at 25 MiB), NOT the checks:
// the handler runs the API policy and the sign-in gate itself.
export const POST = uploadRoute.POST;
export const OPTIONS = uploadRoute.OPTIONS;
export const GET = uploadRoute.GET;
export const HEAD = uploadRoute.HEAD;
export const PUT = uploadRoute.PUT;
export const PATCH = uploadRoute.PATCH;
export const DELETE = uploadRoute.DELETE;
