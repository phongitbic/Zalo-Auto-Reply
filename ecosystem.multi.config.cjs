const common = {
  cwd: __dirname,
  script: "server/src/index.js",
  interpreter: "bun",
  interpreter_args: "--no-env-file",
  autorestart: true,
  max_restarts: 10,
  restart_delay: 2000,
  kill_timeout: 12000,
};

module.exports = {
  apps: Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return {
      ...common,
      name: `zcar-nick${number}`,
      env: {
        NODE_ENV: "production",
        BOT_INSTANCE_ID: `nick${number}`,
        PORT: 3000 + number,
      },
    };
  }),
};
