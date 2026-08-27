import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { PROMO_PRODUCT_KEY, PROMO_SLOTS, readPromoState } from "../_shared/promo.ts";
import { getProduct } from "../_shared/products.ts";

// Whether to SHOW the launch offer, and how many are left. Read-only, grants
// nothing, takes no money.
//
// WHY IT IS A SERVER ENDPOINT AND NOT A CONSTANT IN THE APP. The count is the
// offer. A client that decided for itself would show "3 left" to everybody
// forever, and would keep offering it after the tenth sale to anyone whose
// tab had been open a while. The number has to come from the same place the
// refusal comes from, or the two disagree in front of a customer.
//
// THIS IS NOT THE GATE. razorpay-order re-reads the state and refuses on its
// own; nothing here is trusted for that. A person who calls this, waits, and
// then buys is checked again at order time, which is the only check that
// decides anything. Treat this purely as display.
//
// PRICES COME FROM THE CATALOGUE, not from this file, so the offer cannot
// advertise one number and charge another.

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET or POST" }), { status: 405, headers });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();

  const product = getProduct(PROMO_PRODUCT_KEY);

  // SIGNED OUT IS NOT AN ERROR HERE. Somebody who has not signed in yet is
  // exactly who this offer is aimed at, and they should be able to see it
  // before they commit to an account. They get the headline numbers and
  // `eligible: false`, because eligibility is per account and there is no
  // account yet - the app's job is then to ask them to sign in, not to hide
  // the offer.
  if (!user) {
    return new Response(
      JSON.stringify({
        product: PROMO_PRODUCT_KEY,
        slots: PROMO_SLOTS,
        remaining: null,
        credits: product?.credits ?? null,
        amount: product?.amountCents ?? null,
        currency: product?.currency ?? null,
        label: product?.label ?? null,
        eligible: false,
        already_claimed: false,
        signed_in: false,
      }),
      { status: 200, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
  const state = await readPromoState(admin, user.id);

  return new Response(
    JSON.stringify({
      product: PROMO_PRODUCT_KEY,
      slots: PROMO_SLOTS,
      remaining: state.remaining,
      credits: product?.credits ?? null,
      amount: product?.amountCents ?? null,
      currency: product?.currency ?? null,
      label: product?.label ?? null,
      eligible: state.eligible,
      already_claimed: state.alreadyClaimed,
      signed_in: true,
    }),
    { status: 200, headers },
  );
});
