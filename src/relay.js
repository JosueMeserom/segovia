/**
 * Relevo de subidas, solo en Workers. Desde algunas casas, a ciertas horas, la
 * subida directa a Microsoft se arrastra (0,2 MB/s medidos) y la misma subida
 * pasando por Cloudflare va a decenas de MB/s: la landing manda cada trozo aquí
 * con la uploadUrl en `x-upload-url` y esto lo reenvía tal cual.
 *
 * La uploadUrl ya lleva su permiso (no hace falta el token de la cuenta), así
 * que por aquí no pasa ninguna sesión. Solo se aceptan destinos de subida de
 * OneDrive personal, para no ser un proxy abierto.
 */
const DESTINOS = /^(my\.microsoftpersonalcontent\.com|[a-z0-9-]+\.up\.1drv\.com)$/;

/** @returns {string | null} la uploadUrl si es de OneDrive personal por https */
export function relayTarget(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && DESTINOS.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** @param {Request} req @param {{ PROXY_BASE?: string }} env */
export async function relay(req, env = {}) {
  const cors = {
    'access-control-allow-origin': env.PROXY_BASE ? new URL(env.PROXY_BASE).origin : '*',
    'access-control-allow-methods': 'PUT',
    'access-control-allow-headers': 'content-range, x-upload-url',
    'access-control-max-age': '7200',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const target = relayTarget(req.headers.get('x-upload-url'));
  if (req.method !== 'PUT' || !target) return new Response('Solo PUT a una sesión de subida de OneDrive.\n', { status: 400, headers: cors });

  const headers = {};
  for (const k of ['content-range', 'content-length']) if (req.headers.has(k)) headers[k] = req.headers.get(k);
  const r = await fetch(target, { method: 'PUT', headers, body: req.body });
  return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': r.headers.get('content-type') ?? 'text/plain' } });
}

