import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { CreditPurchase, EntitlementStore } from "./entitlements.ts";

// The database half of the grant, in ONE place for every gateway.
//
// This used to live inside the Paddle webhook. When Stripe arrived it would
// have been copied, and then there would have been two hand-written copies of
// the conditional claim below, which is the single statement that stops a
// retried webhook from paying out twice. Two copies of that is how one of them
// ends up subtly different a month later.
//
// Nothing in here is gateway-specific. `provider` is a string the caller
// passes; everything else is the same SQL whether the money came from Stripe,
// Paddle or something that does not exist yet.
//
// It takes the supabase client rather than importing one, so the function that
// owns the request also owns the connection and the service-role key.

export function supabaseEntitlementStore(
  admin: SupabaseClient,
  logEvent: (name: string, userId: string | null, props: Record<string, unknown>) => Promise<void>,
): EntitlementStore {
  return {
    async recordPurchase(p: CreditPurchase, status: string) {
      // ON CONFLICT DO NOTHING with NO TARGET COLUMNS, which is the whole
      // point: an untargeted DO NOTHING covers EVERY unique constraint on the
      // table, so the primary key catches a retry of the same event AND
      // purchases_txn_idx catches a second event for the same transaction.
      // Naming a conflict target would make the second case a raised 23505
      // instead, which would answer 500 and be retried for days.
      const { error } = await admin.from("purchases").upsert({
        provider: p.provider,
        provider_event_id: p.eventId,
        user_id: p.userId,
        provider_txn_id: p.providerTxnId,
        product_key: p.productKey,
        credits: p.credits,
        amount_cents: p.amountCents,
        currency: p.currency,
        status,
        occurred_at: p.occurredAt,
      }, { ignoreDuplicates: true });
      // 23505 belt and braces: if a PostgREST version ever does target the
      // primary key anyway, a unique violation still means "already known".
      if (error && (error as { code?: string }).code === "23505") return {};
      return { error: error ? String(error.message ?? error) : undefined };
    },

    async claimPurchase(provider: string, eventId: string) {
      // THE CLAIM. One conditional UPDATE, guard in the WHERE clause, no read
      // first. Two concurrent deliveries of the same event both run this;
      // exactly one gets a row back and exactly one grants.
      const { data: rows, error } = await admin
        .from("purchases")
        .update({ status: "granting", updated_at: new Date().toISOString() })
        .eq("provider", provider)
        .eq("provider_event_id", eventId)
        .eq("status", "received")
        .select("user_id, credits");
      if (error) return { claimed: null, error: String(error.message ?? error) };
      const row = (rows ?? [])[0] as { user_id: string | null; credits: number } | undefined;
      return { claimed: row ? { userId: row.user_id, credits: row.credits } : null };
    },

    async addCredits(userId: string, credits: number) {
      const { data: balance, error } = await admin.rpc("grant_project_credits", {
        p_user: userId,
        p_credits: credits,
      });
      if (error) return { balance: null, error: String(error.message ?? error) };
      // -1 is the RPC's "no such profile". A null balance is what
      // applyCreditPurchase reads as a failed grant.
      return { balance: typeof balance === "number" && balance >= 0 ? balance : null };
    },

    async finishPurchase(provider: string, eventId: string, status: string, note?: string | null) {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status, updated_at: now, note: note ?? null };
      if (status === "granted") patch.granted_at = now;
      const { error } = await admin
        .from("purchases")
        .update(patch)
        .eq("provider", provider)
        .eq("provider_event_id", eventId);
      return { error: error ? String(error.message ?? error) : undefined };
    },

    logEvent,
  };
}
