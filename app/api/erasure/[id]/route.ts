import { NextResponse } from "next/server";

import { erasureStatus } from "@/src/server/coordinator/erasure-engine";

export const dynamic = "force-dynamic";

/**
 * The current answer for one request, derived from the ledger every time.
 *
 * Unauthenticated on purpose, and the reason is worth stating: this returns a
 * coverage report, not personal data. It names assets, versions, attestors and
 * gaps. It does not carry the subject's identifiers, because those live on the
 * request record and are not echoed here — a report that leaked the key it was
 * searching for would create fresh copies of the identifier in the act of
 * accounting for its removal, which is the Article 5(1)(c) problem this design
 * already has to answer for elsewhere.
 *
 * Nothing here can change a state. There is no route that marks an asset
 * covered, because a tool to declare work done is a tool for silencing the one
 * thing obsel is for.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const report = await erasureStatus(id);
    const request = { ...report.request } as Partial<typeof report.request>;
    delete request.identifiers;
    return NextResponse.json({ ...report, request });
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read the request";
    const missing = message.includes("no erasure request");
    return NextResponse.json({ error: message }, { status: missing ? 404 : 500 });
  }
}
