import { accessUnlock, accessUnlockPage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = accessUnlockPage;
export const POST = accessUnlock;
