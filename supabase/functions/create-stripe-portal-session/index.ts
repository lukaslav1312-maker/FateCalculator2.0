/**
 * Supabase Edge Function — create-stripe-portal-session
 *
 * Creates a Stripe Billing Portal session for a premium user.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PremiumData = {
  active?: boolean;
  lifetime?: boolean;
  stripeCustomerId?: string | null;
  data?: {
    email?: string | null;
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const username = String(body?.username || '').trim();
    if (!username) {
      return new Response(JSON.stringify({ ok: false, error: 'username is required' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const returnUrl = Deno.env.get('APP_PUBLIC_URL') || 'https://fate-calculator2-0.vercel.app';

    if (!stripeKey || !supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ ok: false, error: 'Server not configured' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/fw_users?select=username,premium&username=eq.${encodeURIComponent(username)}`,
      {
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
      },
    );

    if (!userRes.ok) {
      return new Response(JSON.stringify({ ok: false, error: 'Unable to load user profile' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const rows = await userRes.json().catch(() => [] as Array<{ premium?: PremiumData }>);
    const premium = (rows?.[0]?.premium || {}) as PremiumData;

    if (!premium.active || premium.lifetime) {
      return new Response(JSON.stringify({ ok: false, error: 'No active recurring subscription found' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const customerId = String(premium.stripeCustomerId || '').trim();
    if (!customerId) {
      return new Response(JSON.stringify({ ok: false, error: 'Stripe customer not linked yet for this account' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const form = new URLSearchParams();
    form.set('customer', customerId);
    form.set('return_url', returnUrl);

    const stripeRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    const stripeJson = await stripeRes.json().catch(() => ({}));
    if (!stripeRes.ok || !stripeJson?.url) {
      return new Response(
        JSON.stringify({ ok: false, error: stripeJson?.error?.message || 'Unable to create Stripe portal session' }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(JSON.stringify({ ok: true, url: stripeJson.url }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('create-stripe-portal-session error:', error);
    return new Response(JSON.stringify({ ok: false, error: 'Internal server error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
