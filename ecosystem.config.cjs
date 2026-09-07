module.exports = {
  apps: [{
    name: "zalo-auto-reply",
    cwd: __dirname,
    script: "server/src/index.js",
    interpreter: "bun",
    interpreter_args: "--no-env-file",
    env: { NODE_ENV: "production" },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    kill_timeout: 12000,
  }],
};
