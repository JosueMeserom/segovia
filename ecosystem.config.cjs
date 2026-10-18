/**
 * pm2 start ecosystem.config.cjs
 *
 * Un solo proceso: casi todo el trabajo es esperar a Microsoft y pasar bytes,
 * y la caché de enlaces vive en memoria; con varias instancias cada una
 * resolvería por su cuenta sin ganar nada.
 */
module.exports = {
  apps: [
    {
      name: 'segovia',
      script: 'src/node.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,

      // Carga el .env con el soporte nativo de Node (>=20.6), como en Bayeux:
      // `env_file` de pm2 no lo aplica en todas las versiones, y falla en silencio.
      node_args: '--env-file-if-exists=.env',

      // El proxy no guarda archivos: pasa trozos según llegan. 256M sobra.
      max_memory_restart: '256M',

      out_file: 'logs/segovia.out.log',
      error_file: 'logs/segovia.err.log',
      merge_logs: true,
      time: true,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      kill_timeout: 5000,
    },
  ],
};
