import { timingSafeEqual } from "node:crypto";

export const isInsecureAdminKey = (adminKey) =>
  !adminKey || adminKey === "change-this-long-random-value" || adminKey.length < 32;

export const createTokenMatcher = (adminKey) => (token) => {
  if (!adminKey || typeof token !== "string") return false;
  const expected = Buffer.from(adminKey);
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

export const getRequestToken = (request) => {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-admin-key");
};
