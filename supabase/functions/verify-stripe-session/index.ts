/**
 * Supabase Edge Function — verify-stripe-session
 *
 * Verifies a Stripe Checkout Session ID and activates premium for the user
 * if payment is confirmed.
 *
 * Required environment variables (set in Supabase dashboard → Settings → Edge Functions):
 *   STRIPE_SECRET_KEY        — your Stripe secret key (sk_live_… or sk_test_…)
 *   SUPABASE_URL             — injected automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — injected automatically by Supabase
 *
 * Deploy: supabase functions deploy verify-stripe-session
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function getPlanDurationMs(plan: string): number {
  if (plan === 'monthly') return 30 * 24 * 60 * 60 * 1000;
  if (plan === 'annual') return 365 * 24 * 60 * 60 * 1000;
  return 0;
}

/** Determine plan name from Stripe amount_total (cents). */
function planFromAmount(amountCents: number): 'monthly' | 'annual' | 'lifetime' {
  if (amountCents <= 600)   return 'monthly';   // ≤$6
  if (amountCents <= 3500)  return 'annual';    // ≤$35
  return 'lifetime';
}

function normalizePlan(value: unknown): 'monthly' | 'annual' | 'lifetime' | null {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'monthly' || v === 'annual' || v === 'lifetime') return v;
  return null;
}

function amountForPlan(plan: 'monthly' | 'annual' | 'lifetime'): number {
  if (plan === 'monthly') return 500;
  if (plan === 'annual') return 3000;
  return 5000;
}

function isAmountCompatibleWithPlan(plan: 'monthly' | 'annual' | 'lifetime', amountCents: number): boolean {
  return amountCents === amountForPlan(plan);
}

Deno.serve(async (req: Request) => {
  // Handle CORS pre-flight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { session_id, username, expected_plan } = await req.json() as {
      session_id?: string;
      username?: string;
      expected_plan?: string;
    };

    if (!session_id || !username) {
      return new Response(
        JSON.stringify({ ok: false, error: 'session_id and username are required' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Stripe not configured on server' }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    // ── 1. Fetch the Stripe Checkout Session ──────────────────────────
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`,
      { headers: { Authorization: `Bearer ${stripeKey}` } },
    );

    if (!stripeRes.ok) {
      const err = await stripeRes.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ ok: false, error: (err as any)?.error?.message || 'Invalid Stripe session' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    const session = await stripeRes.json() as Record<string, any>;

    // ── 2. Verify session is complete and paid ─────────────────────────
    if (session.status !== 'complete' || session.payment_status !== 'paid') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Payment not completed' }),
        { status: 402, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Verify the session belongs to this user ─────────────────────
    if (session.client_reference_id !== username) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Session does not match user' }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    // ── 4. Determine plan details ──────────────────────────────────────
    const amountCents = Number(session.amount_subtotal ?? session.amount_total ?? 0);
    const expectedPlan = normalizePlan(expected_plan);
    const plan = expectedPlan && isAmountCompatibleWithPlan(expectedPlan, amountCents)
      ? expectedPlan
      : planFromAmount(amountCents);
    const isLifetime = plan === 'lifetime';
    const renewsAt   = isLifetime ? null : Date.now() + getPlanDurationMs(plan);
    const email      = session.customer_details?.email ?? null;
    const customerId = session.customer ?? null;

    const premium = {
      active:              true,
      lifetime:            isLifetime,
      renewsAt,
      cancelAt:            null,
      cancelRequestedAt:   null,
      stripeSessionId:     session_id,
      stripeCustomerId:    customerId,
      data: {
        email,
        plan,
        paymentMethod: 'stripe',
        date: new Date().toISOString(),
      },
    };

    // ── 5. Persist premium status in Supabase ─────────────────────────
    const supabaseUrl        = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (supabaseUrl && supabaseServiceKey) {
      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/fw_users?username=eq.${encodeURIComponent(username)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
            'apikey':        supabaseServiceKey,
            'Prefer':        'return=representation',
          },
          body: JSON.stringify({ premium }),
        },
      );

      if (!patchRes.ok) {
        console.error('Supabase PATCH error:', patchRes.status, await patchRes.text().catch(() => ''));
        return new Response(
          JSON.stringify({ ok: false, error: 'Failed to persist premium in database' }),
          { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
        );
      }

      const updatedRows = await patchRes.json().catch(() => []);
      if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
        return new Response(
          JSON.stringify({ ok: false, error: 'User account row not found in fw_users' }),
          { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
        );
      }
    } else {
      return new Response(
        JSON.stringify({ ok: false, error: 'Supabase persistence is not configured' }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, plan, isLifetime, renewsAt, email }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('verify-stripe-session error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Internal server error' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }
});
