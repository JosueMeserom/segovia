/**
 * Adaptador de Cloudflare Workers (plan gratuito): solo redirect. Un vídeo en
 * proxy, con cada salto una petición nueva, se comería el cupo diario; una
 * petición en modo proxy se manda a PROXY_BASE, la instancia propia, o se
 * queda en redirect si no hay. La landing la sirve Workers como estático.
 *
 * Además hace de relevo para las subidas (/relay), ver src/relay.js.
 */
import { handle } from './core.js';
import { relay } from './relay.js';

export default {
  fetch: (req, env) =>
    new URL(req.url).pathname === '/relay' ? relay(req, env) : handle(req, { ...env, REDIRECT_ONLY: true }),
};
