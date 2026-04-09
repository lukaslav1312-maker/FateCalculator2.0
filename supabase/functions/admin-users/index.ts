declare const Deno: {
  env: { get(name: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-auth',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const ADMIN_PANEL_HASH = Deno.env.get('ADMIN_PANEL_HASH') || '6g58ph';

function normalizeUserRow(username: string, user: Record<string, unknown>) {
  return {
    username,
    email: typeof user.email === 'string' ? user.email : null,
    auth_user_id: typeof user.authUserId === 'string' ? user.authUserId : null,
    password_hash: typeof user.password === 'string' ? user.password : '',
    created_at_ms: typeof user.created === 'number' ? user.created : Date.now(),
    last_login_ms: typeof user.lastLogin === 'number' ? user.lastLogin : Date.now(),
    premium: user.premium ?? null,
    data: user,
  };
}

function isAuthorized(req: Request) {
  const provided = req.headers.get('x-admin-auth') || '';
  return provided === ADMIN_PANEL_HASH;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${serviceKey}`,
    'apikey': serviceKey,
  };

  try {
    if (req.method === 'GET') {
      const response = await fetch(`${supabaseUrl}/rest/v1/fw_users?select=*`, {
        headers: baseHeaders,
      });
      const users = await response.json().catch(() => []);
      if (!response.ok) {
        return new Response(JSON.stringify({ error: 'Failed to fetch users' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ users }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'POST') {
      const { users } = await req.json() as { users?: Record<string, Record<string, unknown>> };
      const userMap = users && typeof users === 'object' ? users : {};
      const entries = Object.entries(userMap);
      const payload = entries.map(([username, user]) => normalizeUserRow(username, user));

      const existingResponse = await fetch(`${supabaseUrl}/rest/v1/fw_users?select=username`, {
        headers: baseHeaders,
      });
      const existingRows = await existingResponse.json().catch(() => []);
      if (!existingResponse.ok) {
        return new Response(JSON.stringify({ error: 'Failed to fetch existing users' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      if (payload.length) {
        const upsertResponse = await fetch(`${supabaseUrl}/rest/v1/fw_users`, {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(payload),
        });
        if (!upsertResponse.ok) {
          return new Response(JSON.stringify({ error: 'Failed to upsert users' }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
      }

      const existing = new Set((existingRows as Array<{ username: string }>).map((row) => row.username));
      const current = new Set(entries.map(([username]) => username));
      const toDelete = Array.from(existing).filter((username) => !current.has(username));
      if (toDelete.length) {
        const deleteResponse = await fetch(`${supabaseUrl}/rest/v1/fw_users?username=in.(${toDelete.map((username) => encodeURIComponent(username)).join(',')})`, {
          method: 'DELETE',
          headers: {
            ...baseHeaders,
            'Prefer': 'return=minimal',
          },
        });
        if (!deleteResponse.ok) {
          return new Response(JSON.stringify({ error: 'Failed to delete removed users' }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('admin-users error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});