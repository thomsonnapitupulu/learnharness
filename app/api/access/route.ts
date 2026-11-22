import { accessSignOutAll, accessStatus } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = accessStatus;
export const POST = accessSignOutAll;
