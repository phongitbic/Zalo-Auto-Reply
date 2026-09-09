import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Elysia, file } from "elysia";
import { getRequestToken } from "./auth.js";
import { parsePriorityRouteFile, priorityRouteKey } from "./priority-routes.js";

const errorResponse = (set, status, message, extra = {}) => {
  set.status = status;
  return { error: message, ...extra };
};

export const createApiRoutes = ({ config, runtime, tokenMatches }) =>
  new Elysia({ name: "api-routes", prefix: "/api" })
    .onBeforeHandle(({ request, set }) => {
      if (!tokenMatches(getRequestToken(request))) {
        return errorResponse(set, 401, "Unauthorized");
      }
    })
    .get("/status", () => runtime.snapshot())
    .get("/bootstrap", () => runtime.bootstrap())
    .get("/zalo/qr", async ({ set }) => {
      try {
        await fs.access(config.qrFile);
        set.headers["cache-control"] = "no-store";
        return file(config.qrFile);
      } catch (error) {
        if (error.code === "ENOENT") {
          return errorResponse(set, 404, "QR is not currently required.");
        }
        return errorResponse(set, 500, "Could not read the QR code.");
      }
    })
    .post("/bot/control", async ({ body, set }) => {
      const action = body?.action;
      const mode = body?.mode;
      if (!["start", "stop"].includes(action) || (mode && !["all", "priority"].includes(mode))) {
        return errorResponse(set, 400, "Thao tác hoặc chế độ không hợp lệ.");
      }
      try {
        return await runtime.persistControl({ enabled: action === "start", mode });
      } catch (error) {
        console.error("Saving bot control state failed:", error);
        return errorResponse(set, 500, "Không thể lưu trạng thái bot.");
      }
    })
    .post("/bot/enabled", async ({ body, set }) => {
      try {
        return await runtime.persistControl({ enabled: Boolean(body.enabled) });
      } catch {
        return errorResponse(set, 500, "Không thể lưu trạng thái bot.");
      }
    })
    .post("/bot/priority-only", async ({ body, set }) => {
      try {
        return await runtime.persistControl({ mode: body.enabled ? "priority" : "all" });
      } catch {
        return errorResponse(set, 500, "Không thể lưu chế độ bot.");
      }
    })
    .post("/settings/priority-routes/preview", ({ body, set }) => {
      const { content, fileName } = body ?? {};
      if (typeof content !== "string") {
        return errorResponse(set, 400, "Nội dung file phải là văn bản.");
      }
      if (!String(fileName || "").toLowerCase().endsWith(".txt")) {
        return errorResponse(set, 400, "Chỉ chấp nhận file .txt.");
      }
      const preview = runtime.importPreview(content, fileName);
      if (preview.errors.length) {
        return errorResponse(set, 400, "File có dòng không hợp lệ.", { preview });
      }
      if (!preview.validRouteCount) {
        return errorResponse(set, 400, "File không có tuyến hợp lệ.", { preview });
      }
      if (preview.validRouteCount > 5000) {
        return errorResponse(set, 400, "Mỗi file có tối đa 5.000 tuyến.", { preview });
      }
      return { preview };
    })
    .post("/settings/priority-routes/import", async ({ body, set }) => {
      const { content, fileName } = body ?? {};
      if (typeof content !== "string" || !String(fileName || "").toLowerCase().endsWith(".txt")) {
        return errorResponse(set, 400, "Cần cung cấp file .txt hợp lệ.");
      }
      const parsed = parsePriorityRouteFile(content, { fileName: path.basename(fileName) });
      if (parsed.errors.length) {
        return errorResponse(set, 400, "File có dòng không hợp lệ; cấu hình hiện tại không thay đổi.", {
          preview: parsed,
        });
      }
      if (!parsed.validRouteCount) return errorResponse(set, 400, "File không có tuyến hợp lệ.");
      if (parsed.validRouteCount > 5000) {
        return errorResponse(set, 400, "Mỗi file có tối đa 5.000 tuyến.");
      }
      try {
        const { response } = await runtime.importPriorityRoutes(parsed, fileName);
        set.status = 201;
        return { ...response.status, save: response.save, import: response.result };
      } catch (error) {
        console.error("Importing priority routes failed:", error);
        return errorResponse(set, 500, "Không thể lưu danh sách tuyến ưu tiên.");
      }
    })
    .post("/settings/priority-routes", async ({ body, set }) => {
      try {
        const route = runtime.validateRouteRequest(body ?? {}, { id: randomUUID() });
        const response = await runtime.updatePriorityRoutes((current) => {
          if (current.some((item) => priorityRouteKey(item) === priorityRouteKey(route))) {
            const error = new Error("Tuyến này đã tồn tại.");
            error.code = "DUPLICATE_ROUTE";
            throw error;
          }
          return [...current, route];
        });
        set.status = 201;
        return { ...response.status, save: response.save };
      } catch (error) {
        const status = ["INVALID_ROUTE", "DUPLICATE_ROUTE"].includes(error.code) ? 400 : 500;
        return errorResponse(set, status, error.message || "Không thể thêm tuyến.");
      }
    })
    .patch("/settings/priority-routes", async ({ body, set }) => {
      if (typeof body?.enabled !== "boolean") {
        return errorResponse(set, 400, "Trạng thái bật/tắt không hợp lệ.");
      }
      try {
        const response = await runtime.updatePriorityRoutes((current) => current.map((route) => ({
          ...route,
          enabled: body.enabled,
          updatedAt: new Date().toISOString(),
        })));
        return { ...response.status, save: response.save };
      } catch {
        return errorResponse(set, 500, "Không thể cập nhật tất cả tuyến.");
      }
    })
    .patch("/settings/priority-routes/:id", async ({ body, params, set }) => {
      try {
        const response = await runtime.updatePriorityRoutes((current) => {
          const index = current.findIndex((route) => route.id === params.id);
          if (index === -1) {
            const error = new Error("Không tìm thấy tuyến.");
            error.code = "ROUTE_NOT_FOUND";
            throw error;
          }
          const changed = runtime.validateRouteRequest(body ?? {}, current[index]);
          if (current.some((item, itemIndex) =>
            itemIndex !== index && priorityRouteKey(item) === priorityRouteKey(changed))) {
            const error = new Error("Tuyến này bị trùng với tuyến đã có.");
            error.code = "DUPLICATE_ROUTE";
            throw error;
          }
          return current.map((route, itemIndex) => itemIndex === index ? changed : route);
        });
        return { ...response.status, save: response.save };
      } catch (error) {
        if (error.code === "ROUTE_NOT_FOUND") return errorResponse(set, 404, error.message);
        if (["INVALID_ROUTE", "DUPLICATE_ROUTE"].includes(error.code)) {
          return errorResponse(set, 400, error.message);
        }
        return errorResponse(set, 500, error.message || "Không thể cập nhật tuyến.");
      }
    })
    .delete("/settings/priority-routes/:id", async ({ params, set }) => {
      try {
        const response = await runtime.updatePriorityRoutes((current) => {
          if (!current.some((route) => route.id === params.id)) {
            const error = new Error("Không tìm thấy tuyến.");
            error.code = "ROUTE_NOT_FOUND";
            throw error;
          }
          return current.filter((route) => route.id !== params.id);
        });
        return { ...response.status, save: response.save };
      } catch (error) {
        if (error.code === "ROUTE_NOT_FOUND") return errorResponse(set, 404, error.message);
        return errorResponse(set, 500, "Không thể xóa tuyến.");
      }
    })
    .get("/settings/priority-routes/export", ({ set }) => {
      const exportedAt = new Date().toISOString();
      set.headers["content-disposition"] =
        `attachment; filename="priority-routes-${exportedAt.slice(0, 10)}.json"`;
      return { exportedAt, routes: runtime.getPriorityRoutes() };
    });
