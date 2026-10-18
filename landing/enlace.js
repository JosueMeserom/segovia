/**
 * Conversión entre enlaces de OneDrive y rutas de Segovia. La usan el servidor
 * (src/core.js) y la landing, por eso vive aquí y no depende de nada.
 *
 *   https://1drv.ms/v/c/<cid>/<id>?e=…   →  /v/c/<cid>/<id>
 *   https://1drv.ms/v/s!<id>             →  /v/s!<id>
 *   https://onedrive.live.com/…          →  /u/<el enlace entero en base64url>
 *
 * Los de 1drv.ms ya son seguros en una URL, así que basta con cambiar el
 * dominio. El `?e=` es de seguimiento: Microsoft resuelve igual sin él.
 */

const CORTO = /^\/[a-z]\/(?:c\/[0-9a-f]+\/[\w-]+|s![\w-]+)$/i;
const LARGO = 'onedrive.live.com';

/** OneDrive de empresa y SharePoint: no soportado (el flujo anónimo es otro). */
export const esEmpresa = (host) => /(^|\.)sharepoint\.com$/i.test(host);

/** @returns {string | null} la ruta de Segovia, o null si no es un enlace de OneDrive personal */
export function toPath(link) {
  let u;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.hostname === '1drv.ms') return CORTO.test(u.pathname) ? u.pathname : null;
  if (u.hostname === LARGO) return '/u/' + b64url(u.href);
  return null;
}

/** @returns {string | null} el enlace de OneDrive, o null si la ruta no es de Segovia */
export function fromPath(path) {
  if (CORTO.test(path)) return 'https://1drv.ms' + path;
  if (!path.startsWith('/u/')) return null;
  try {
    const link = unb64url(path.slice(3));
    return new URL(link).hostname === LARGO ? link : null;
  } catch {
    return null;
  }
}

export function b64url(s) {
  const bin = String.fromCharCode(...new TextEncoder().encode(s));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
