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
  if (!input) return "Hãy nhập địa chỉ kết nối";

  let url;
  try {
    url = new URL(input);
  } catch {
    return "Địa chỉ kết nối không hợp lệ. Hãy nhập đầy đủ http:// hoặc https://";
  }

  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return "Chỉ nhập địa chỉ kết nối gốc, không thêm tài khoản, đường dẫn hoặc tham số";
  }
  if (url.protocol === "https:" || url.protocol === "http:") return "";
  return "Địa chỉ kết nối phải bắt đầu bằng http:// hoặc https://";
};
