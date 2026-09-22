export const resolveProxyConfig = (value = "") => {
  const rawValue = String(value).trim();
  if (!rawValue) return { url: "", target: null };

  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error("ZALO_PROXY_AGENT is not a valid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("ZALO_PROXY_AGENT must use http:// or https://.");
  }
  if (!parsed.hostname) throw new Error("ZALO_PROXY_AGENT is missing a host.");

  return {
    url: parsed.href,
    target: `${parsed.protocol}//${parsed.host}`,
  };
};
