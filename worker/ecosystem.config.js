module.exports = {
  apps: [
    {
      name: 'fb-poster',
      script: 'src/index.js',
      cwd: '/home/ubuntu/app/worker',
      node_args: '--expose-gc --max-old-space-size=512',

      // Recharge le .env à chaque restart
      env_file: '/home/ubuntu/app/worker/.env',

      // Redémarre si l'app dépasse 800 Mo (Chromium peut fuir)
      max_memory_restart: '800M',

      // Attend 5s entre deux redémarrages pour éviter une boucle rapide
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',

      // Logs
      error_file: '/home/ubuntu/logs/fb-poster-err.log',
      out_file: '/home/ubuntu/logs/fb-poster-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
