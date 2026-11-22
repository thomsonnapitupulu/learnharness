import { accessSignOut, accessSignOutPage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = accessSignOutPage;
export const POST = accessSignOut;
