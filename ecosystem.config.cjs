// pm2 进程管理配置（CommonJS，与项目 ESM 解耦；pm2 直接 require 本文件）。
// 部署：pm2 start ecosystem.config.cjs --env production
// 关键约束：JSON 单实例，instances 必须为 1（多进程会互相覆盖 db.json）。
const path = require('path');

module.exports = {
  apps: [{
    name: 'kids-trip-server',
    script: 'server.js',
    cwd: '/opt/kids-trip-server',
    instances: 1,                  // JSON 单实例：严禁多进程并发写
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '512M',
    node_args: '--max-old-space-size=512',
    // 注：本服务器 pm2 守护进程以 ubuntu 运行（与既有 mcp/poker/szw 等同例），
    // 非 root 无法 setuid 到 kts，故此处不降权，应用随 pm2 以 ubuntu 运行。
    // 非生产（pm2 start 不加 --env 时）
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '127.0.0.1',
      DEV_MODE: 'true',
      DATA_FILE: './data/db.json',
    },
    // 生产（pm2 start ecosystem.config.cjs --env production）
    env_production: {
      NODE_ENV: 'production',
      PORT: 8099,
      HOST: '127.0.0.1',          // 仅环回，公网不可达，由 nginx 反代
      DEV_MODE: 'false',
      DATA_FILE: '/var/lib/kids-trip/db.json',
      // TOKEN_SECRET 由部署机 shell 注入（deploy.sh 用 openssl rand -hex 32 生成），绝不入库
      TOKEN_SECRET: process.env.KTS_TOKEN_SECRET || 'CHANGE_ME_generate_with_openssl_rand_hex_32',
      TOKEN_TTL_DAYS: 7,
      WECHAT_APPID: process.env.WECHAT_APPID || 'YOUR_WECHAT_APPID',
      AI_MODEL: 'template',
      RL_GUIDE_PER_SPOT_DAY: 10,
      RL_COMMENT_PER_HOUR: 60,
      MODERATION: 'true',
      AI_REVIEW_AUTO_RETRY_FAILED: 'false',
    },
  }],
};
