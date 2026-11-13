/**
 * Adaptador de Cloudflare Workers (plan gratuito). Un vídeo en proxy, con cada
 * salto una petición nueva, se comería el cupo diario, así que una petición en
 * modo proxy se manda a PROXY_BASE, la instancia propia, o se queda en redirect
 * si no hay. El modo relay sí se sirve aquí, a propósito: es para cuando lo
 * directo va mal. La landing la sirve Workers como estático.
 *
 * Además hace de relevo (/relay) para las subidas y para el servido por ID de
 * la instancia propia, ver src/relay.js.
 */
import { handle } from './core.js';
import { relay } from './relay.js';

export default {
  fetch: (req, env) =>
    new URL(req.url).pathname === '/relay' ? relay(req, env) : handle(req, { ...env, REDIRECT_ONLY: true }),
};
