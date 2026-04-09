/**
 * Supabase Edge Function — stripe-webhook
 *
 * Receives Stripe webhook events and updates premium status in Supabase.
 *
 * Required environment variables (Supabase dashboard → Settings → Edge Functions):
 *   STRIPE_SECRET_KEY        — your Stripe secret key (sk_live_… or sk_test_…)
 *   STRIPE_WEBHOOK_SECRET    — whsec_… from your Stripe webhook endpoint
 *   SUPABASE_URL             — injected automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — injected automatically by Supabase
 *
 * How to configure in Stripe dashboard:
 *   1. Go to Developers → Webhooks → Add endpoint
 *   2. URL: https://<project>.supabase.co/functions/v1/stripe-webhook
 *   3. Events to listen:
 *        checkout.session.completed
 *        customer.subscription.deleted
 *        customer.subscription.updated
 *   4. Copy the Signing secret → set as STRIPE_WEBHOOK_SECRET
 *
 * Deploy: supabase functions deploy stripe-webhook
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function getPlanDurationMs(plan: string): number {
  if (plan === 'monthly') return 30 * 24 * 60 * 60 * 1000;
  if (plan === 'annual')  return 365 * 24 * 60 * 60 * 1000;
  return 0;
}

function planFromAmount(amountCents: number): 'monthly' | 'annual' | 'lifetime' {
  if (amountCents <= 600)  return 'monthly';
  if (amountCents <= 3500) return 'annual';
  return 'lifetime';
}

/** Verify Stripe webhook signature using HMAC-SHA256 */
async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(s => s.split('=')));
    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) return false;

    const signed = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
    const expected = Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return expected === signature;
  } catch {
    return false;
  }
}

async function patchUserPremium(
  supabaseUrl: string,
  serviceKey: string,
  username: string,
  premium: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/fw_users?username=eq.${encodeURIComponent(username)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${serviceKey}`,
        'apikey':        serviceKey,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({ premium }),
    },
  );
  if (!res.ok) {
    console.error('patchUserPremium error:', res.status, await res.text().catch(() => ''));
  }
}

async function findUserByCustomerId(
  supabaseUrl: string,
  serviceKey: string,
  customerId: string,
): Promise<string | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/fw_users?select=username,premium`,
    {
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey:        serviceKey,
      },
    },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ username: string; premium: any }>;
  const match = rows.find(r => r.premium?.stripeCustomerId === customerId);
  return match?.username ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  const supabaseUrl        = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const stripeKey          = Deno.env.get('STRIPE_SECRET_KEY');
  const webhookSecret      = Deno.env.get('STRIPE_WEBHOOK_SECRET');

  if (!supabaseUrl || !supabaseServiceKey || !stripeKey) {
    return new Response(
      JSON.stringify({ error: 'Server not configured' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  const body = await req.text();

  // ── Verify Stripe signature ──────────────────────────────────────────
  if (webhookSecret) {
    const sig = req.headers.get('stripe-signature') ?? '';
    const valid = await verifyStripeSignature(body, sig, webhookSecret);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: 'Invalid signature' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  // ── Handle events ────────────────────────────────────────────────────
  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const username = session.client_reference_id as string | undefined;
        if (!username || session.payment_status !== 'paid') break;

        const plan        = planFromAmount(session.amount_total ?? 0);
        const isLifetime  = plan === 'lifetime';
        const renewsAt    = isLifetime ? null : Date.now() + getPlanDurationMs(plan);
        const email       = session.customer_details?.email ?? null;
        const customerId  = session.customer ?? null;

        await patchUserPremium(supabaseUrl, supabaseServiceKey, username, {
          active:             true,
          lifetime:           isLifetime,
          renewsAt,
          cancelAt:           null,
          cancelRequestedAt:  null,
          stripeSessionId:    session.id,
          stripeCustomerId:   customerId,
          data: { email, plan, paymentMethod: 'stripe', date: new Date().toISOString() },
        });
        console.log(`Premium activated for user "${username}" (${plan})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub        = event.data.object;
        const customerId = sub.customer as string;
        const username   = await findUserByCustomerId(supabaseUrl, supabaseServiceKey, customerId);
        if (!username) break;

        await patchUserPremium(supabaseUrl, supabaseServiceKey, username, {
          active:    false,
          lifetime:  false,
          renewsAt:  null,
          cancelAt:  Date.now(),
          cancelled: true,
          data: { plan: null, paymentMethod: 'stripe', cancelDate: new Date().toISOString() },
        });
        console.log(`Premium cancelled for user "${username}"`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub        = event.data.object;
        const customerId = sub.customer as string;
        const username   = await findUserByCustomerId(supabaseUrl, supabaseServiceKey, customerId);
        if (!username) break;

        const isActive           = sub.status === 'active';
        const currentPeriodEnd   = sub.current_period_end
          ? (sub.current_period_end as number) * 1000
          : null;

        await patchUserPremium(supabaseUrl, supabaseServiceKey, username, {
          active:           isActive,
          renewsAt:         currentPeriodEnd,
          cancelAt:         sub.cancel_at ? (sub.cancel_at as number) * 1000 : null,
          cancelRequestedAt: sub.cancel_at ? Date.now() : null,
        });
        console.log(`Premium updated for user "${username}" (active=${isActive})`);
        break;
      }

      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return new Response(
      JSON.stringify({ error: 'Handler error' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ received: true }),
    { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
});
