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
  if (url.protocol === "https:" || url.protocol === "http:") return "";
  return "Địa chỉ máy chủ phải bắt đầu bằng http:// hoặc https://";
};
