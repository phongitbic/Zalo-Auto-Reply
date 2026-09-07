const stripIpv6Brackets = (hostname) => hostname.replace(/^\[|\]$/g, "").toLowerCase();

const parseIpv4 = (hostname) => {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
};

export const isPrivateServerHost = (hostname) => {
  const host = stripIpv6Brackets(hostname);
  if (host === "localhost" || host === "::1") return true;
  if (/^(fc|fd)/.test(host) || /^fe[89ab]/.test(host)) return true;

  const octets = parseIpv4(host);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
};

export const normalizeServerUrl = (value) => {
  const input = value.trim().replace(/\/+$/, "");
  if (!input) return "";
  try {
    return new URL(input).origin;
  } catch {
    return input;
  }
};

export const validateNativeServerUrl = (value) => {
  const input = value.trim();
  if (!input) return "Hãy nhập địa chỉ máy chủ, ví dụ http://192.168.1.10:3001";

  let url;
  try {
    url = new URL(input);
  } catch {
    return "Địa chỉ máy chủ không hợp lệ. Hãy nhập đầy đủ http:// hoặc https://";
  }

  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return "Chỉ nhập địa chỉ gốc của máy chủ, không thêm tài khoản, đường dẫn hoặc tham số";
  }
  if (url.protocol === "https:") return "";
  if (url.protocol === "http:" && isPrivateServerHost(url.hostname)) return "";
  if (url.protocol === "http:") {
    return "HTTP chỉ được dùng với IP mạng nội bộ; máy chủ Internet cần HTTPS hoặc mạng riêng Tailscale";
  }
  return "Địa chỉ máy chủ phải bắt đầu bằng http:// hoặc https://";
};
