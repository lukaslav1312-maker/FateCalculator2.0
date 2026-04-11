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
  stripeSessionId?: string | null;
  data?: {
    email?: string | null;
  };
};

async function patchPremiumData(
  supabaseUrl: string,
  serviceKey: string,
  username: string,
  premium: PremiumData,
): Promise<boolean> {
  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/fw_users?username=eq.${encodeURIComponent(username)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ premium }),
    },
  );

  if (!patchRes.ok) {
    console.error('patchPremiumData failed:', patchRes.status, await patchRes.text().catch(() => ''));
    return false;
  }

  const rows = await patchRes.json().catch(() => [] as Array<Record<string, unknown>>);
  return Array.isArray(rows) && rows.length > 0;
}

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

    let customerId = String(premium.stripeCustomerId || '').trim();

    // Backward-compatible repair for older premium rows that missed stripeCustomerId.
    if (!customerId) {
      const stripeSessionId = String(premium.stripeSessionId || '').trim();
      if (stripeSessionId) {
        const sessionRes = await fetch(
          `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(stripeSessionId)}`,
          {
            headers: { Authorization: `Bearer ${stripeKey}` },
          },
        );
        if (sessionRes.ok) {
          const sessionJson = await sessionRes.json().catch(() => ({} as Record<string, unknown>));
          const recovered = String((sessionJson as { customer?: string | null }).customer || '').trim();
          if (recovered) {
            customerId = recovered;
            const updatedPremium: PremiumData = { ...premium, stripeCustomerId: customerId };
            await patchPremiumData(supabaseUrl, serviceKey, username, updatedPremium);
          }
        } else {
          console.warn('Unable to recover Stripe customer from session:', stripeSessionId);
        }
      }
    }

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
