const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const proxyEnvironmentName = (instanceId = "") => {
  if (!instanceId) return "ZALO_PROXY_AGENT";
  if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error("Invalid bot instance ID.");
  return `ZALO_PROXY_AGENT_${instanceId.toUpperCase()}`;
};

export const resolveProxyConfig = (environment, instanceId = "") => {
  const environmentName = proxyEnvironmentName(instanceId);
  const value = String(environment[environmentName] || "").trim();
  if (!value) return { environmentName, url: "", target: null };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${environmentName} is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${environmentName} must use http:// or https://.`);
  }
  if (!parsed.hostname) throw new Error(`${environmentName} is missing a host.`);

  return {
    environmentName,
    url: parsed.href,
    target: `${parsed.protocol}//${parsed.host}`,
  };
};
