import React from "react";
import { createRoot } from "react-dom/client";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { io } from "socket.io-client";
import { normalizeServerUrl, validateNativeServerUrl } from "./server-url.js";
import "./styles.css";

const OrderService = registerPlugin("OrderService");
const isNative = Capacitor.isNativePlatform();
const storage = {
  get: (key, fallback = "") => localStorage.getItem(key) ?? fallback,
  set: (key, value) => localStorage.setItem(key, value),
};
const emptyRoute = () => ({
  id: null,
  origin: "",
  destination: "",
  originAliases: "",
  destinationAliases: "",
  enabled: true,
  twoWay: true,
});
const formatTime = (value) => value ? new Date(value).toLocaleString("vi-VN") : "--";
const modeText = (status) => !status?.enabled
  ? "Đã dừng nhận đơn"
  : status.mode === "priority" ? "Đang nhận cuốc ưu tiên" : "Đang nhận tất cả";

function App() {
  const socketRef = React.useRef(null);
  const seenEvents = React.useRef(new Set());
  const [serverUrl, setServerUrl] = React.useState(() => storage.get("serverUrl"));
  const [adminToken, setAdminToken] = React.useState(() => isNative ? "" : storage.get("adminToken"));
  const [autoConnectReady, setAutoConnectReady] = React.useState(() => !isNative && Boolean(storage.get("adminToken")));
  const [status, setStatus] = React.useState(null);
  const [qrRevision, setQrRevision] = React.useState("");
  const [orders, setOrders] = React.useState([]);
  const [connectionState, setConnectionState] = React.useState("disconnected");
  const [page, setPage] = React.useState("dashboard");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [savingRouteId, setSavingRouteId] = React.useState(null);
  const [routeSearch, setRouteSearch] = React.useState("");
  const [routeFilter, setRouteFilter] = React.useState("all");
  const [routeDraft, setRouteDraft] = React.useState(null);
  const [importDialog, setImportDialog] = React.useState(null);
  const [overlayEnabled, setOverlayEnabled] = React.useState(false);
  const [notificationSettings, setNotificationSettings] = React.useState(() => {
    try {
      return JSON.parse(storage.get("notificationSettings", "")) || { sound: true, vibrate: true, speech: false };
    } catch {
      return { sound: true, vibrate: true, speech: false };
    }
  });

  const apiUrl = React.useCallback((endpoint) => `${normalizeServerUrl(serverUrl)}${endpoint}`, [serverUrl]);
  const apiFetch = React.useCallback(async (endpoint, options = {}) => {
    const response = await fetch(apiUrl(endpoint), {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${adminToken}`,
        ...options.headers,
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 401 ? "Token quản trị không đúng" : result.error || "Máy chủ không phản hồi");
      error.payload = result;
      throw error;
    }
    return result;
  }, [adminToken, apiUrl]);

  const notifyOrder = React.useCallback(async (order) => {
    const dedupeKey = order.eventId || order.messageId;
    if (!dedupeKey || seenEvents.current.has(dedupeKey)) return;
    seenEvents.current.add(dedupeKey);
    if (isNative) {
      await OrderService.handleOrder({ order, settings: notificationSettings }).catch(() => {});
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification("ĐÃ NHẬN ĐƠN THÀNH CÔNG!", {
        body: `${order.senderName || order.groupName}\n${order.originalContent}`,
      });
    }
  }, [notificationSettings]);

  const connect = React.useCallback(async ({ quiet = false } = {}) => {
    const baseUrl = normalizeServerUrl(serverUrl);
    const serverUrlError = isNative ? validateNativeServerUrl(serverUrl) : "";
    if (serverUrlError) {
      if (!quiet) setNotice(serverUrlError);
      return;
    }
    if (!adminToken.trim()) {
      if (!quiet) setNotice("Hãy nhập token quản trị");
      return;
    }
    setConnectionState("connecting");
    try {
      const bootstrap = await apiFetch("/api/bootstrap");
      setStatus(bootstrap.status);
      setOrders(bootstrap.orders || []);
      bootstrap.orders?.forEach((order) => seenEvents.current.add(order.eventId || order.messageId));
      storage.set("serverUrl", baseUrl);
      if (isNative) localStorage.removeItem("adminToken");
      else storage.set("adminToken", adminToken);
      socketRef.current?.disconnect();
      const socket = io(baseUrl || undefined, {
        auth: { token: adminToken },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        timeout: 10000,
      });
      socketRef.current = socket;
      socket.on("connect", () => {
        setConnectionState("connected");
        if (!quiet) setNotice("Đã kết nối và đồng bộ với máy chủ");
      });
      socket.on("disconnect", () => setConnectionState("disconnected"));
      socket.on("connect_error", (error) => {
        setConnectionState("error");
        setNotice(error.message === "Unauthorized" ? "Token quản trị không đúng" : "Mất kết nối máy chủ");
      });
      socket.on("status", setStatus);
      socket.on("qr", (event) => setQrRevision(event?.updatedAt || String(Date.now())));
      socket.on("stats", (stats) => setStatus((current) => current ? { ...current, stats } : current));
      socket.on("redis", (redis) => setStatus((current) => current ? { ...current, redis } : current));
      socket.on("orders", (items) => setOrders(items || []));
      socket.on("ORDER_ACCEPTED", (order) => {
        setOrders((items) => [order, ...items.filter((item) => item.eventId !== order.eventId)].slice(0, 500));
        void notifyOrder(order);
      });
      if (isNative) {
        const permission = await LocalNotifications.checkPermissions();
        if (permission.display !== "granted") await LocalNotifications.requestPermissions();
        await OrderService.start({ serverUrl: baseUrl, token: adminToken, settings: notificationSettings });
      } else if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch (error) {
      setConnectionState("error");
      if (!quiet) setNotice(error.message);
    }
  }, [adminToken, apiFetch, notificationSettings, notifyOrder, serverUrl]);

  React.useEffect(() => {
    let cancelled = false;
    if (isNative) {
      localStorage.removeItem("adminToken");
      void OrderService.getConnection().then((saved) => {
        if (cancelled || !saved?.token || !saved?.serverUrl) return;
        setServerUrl(saved.serverUrl);
        setAdminToken(saved.token);
        setAutoConnectReady(true);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, []);
  React.useEffect(() => {
    if (!autoConnectReady) return;
    setAutoConnectReady(false);
    void connect({ quiet: true });
  }, [autoConnectReady, connect]);
  React.useEffect(() => () => socketRef.current?.disconnect(), []);
  React.useEffect(() => {
    storage.set("notificationSettings", JSON.stringify(notificationSettings));
    if (isNative) void OrderService.updateSettings({ settings: notificationSettings }).catch(() => {});
  }, [notificationSettings]);

  const showSaved = (result, successText) => {
    setStatus(result);
    setNotice(result.save?.pending
      ? `${successText}. Redis đang mất kết nối; máy chủ sẽ tự đồng bộ lại.`
      : `${successText} và Redis đã xác nhận lưu.`);
  };

  async function control(action, mode = status?.mode || "all") {
    setBusy(true);
    try {
      const result = await apiFetch("/api/bot/control", {
        method: "POST",
        body: JSON.stringify({ action, mode }),
      });
      showSaved(result, action === "start" ? "Máy chủ đã bắt đầu nhận đơn" : "Máy chủ đã dừng nhận đơn");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRoute() {
    setBusy(true);
    try {
      const body = {
        origin: routeDraft.origin,
        destination: routeDraft.destination,
        originAliases: routeDraft.originAliases.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean),
        destinationAliases: routeDraft.destinationAliases.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean),
        enabled: routeDraft.enabled,
        twoWay: routeDraft.twoWay,
      };
      const endpoint = routeDraft.id
        ? `/api/settings/priority-routes/${routeDraft.id}`
        : "/api/settings/priority-routes";
      const result = await apiFetch(endpoint, {
        method: routeDraft.id ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      setRouteDraft(null);
      showSaved(result, routeDraft.id ? "Đã cập nhật tuyến" : "Đã thêm tuyến");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateRoute(route, change) {
    setSavingRouteId(route.id);
    try {
      const result = await apiFetch(`/api/settings/priority-routes/${route.id}`, {
        method: "PATCH",
        body: JSON.stringify(change),
      });
      showSaved(result, "Đã cập nhật tuyến");
    } catch (error) {
      setNotice(`Lưu thất bại: ${error.message}`);
    } finally {
      setSavingRouteId(null);
    }
  }

  async function deleteRoute(route) {
    if (!window.confirm(`Xóa tuyến ${route.origin} → ${route.destination}?`)) return;
    setSavingRouteId(route.id);
    try {
      const result = await apiFetch(`/api/settings/priority-routes/${route.id}`, { method: "DELETE" });
      showSaved(result, "Đã xóa tuyến");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSavingRouteId(null);
    }
  }

  async function toggleAll(enabled) {
    setSavingRouteId("all");
    try {
      const result = await apiFetch("/api/settings/priority-routes", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      showSaved(result, enabled ? "Đã bật tất cả tuyến" : "Đã tắt tất cả tuyến");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSavingRouteId(null);
    }
  }

  async function previewFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setNotice("Chỉ chấp nhận file .txt");
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      const result = await apiFetch("/api/settings/priority-routes/preview", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, content }),
      });
      setImportDialog({ fileName: file.name, content, preview: result.preview });
    } catch (error) {
      if (error.payload?.preview) setImportDialog({ fileName: file.name, content: await file.text(), preview: error.payload.preview });
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    setBusy(true);
    try {
      const result = await apiFetch("/api/settings/priority-routes/import", {
        method: "POST",
        body: JSON.stringify({ fileName: importDialog.fileName, content: importDialog.content }),
      });
      setImportDialog(null);
      showSaved(result, `Đã nhập ${result.import?.added ?? 0} tuyến`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadBackup() {
    try {
      const result = await apiFetch("/api/settings/priority-routes/export");
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `priority-routes-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function toggleOverlay() {
    if (!isNative) return setNotice("Nút nổi chỉ hoạt động trong ứng dụng Android");
    const enabled = !overlayEnabled;
    try {
      await OrderService.setOverlay({ enabled });
      setOverlayEnabled(enabled);
    } catch (error) {
      setNotice(error.message || "Chưa cấp quyền hiển thị trên ứng dụng khác");
    }
  }

  const successfulOrders = orders.filter((order) => order.status === "success");
  const today = new Date().toDateString();
  const todayCount = successfulOrders.filter((order) => new Date(order.sentAt).toDateString() === today).length;
  const routes = status?.priorityRoutes || [];
  const query = routeSearch.trim().toLocaleLowerCase("vi");
  const visibleRoutes = routes.filter((route) => {
    const matchesSearch = !query || `${route.origin} ${route.destination} ${route.originAliases.join(" ")} ${route.destinationAliases.join(" ")}`.toLocaleLowerCase("vi").includes(query);
    const matchesFilter = routeFilter === "all" || (routeFilter === "enabled" ? route.enabled : !route.enabled);
    return matchesSearch && matchesFilter;
  });

  if (!status) return <ConnectScreen {...{ serverUrl, setServerUrl, adminToken, setAdminToken, connectionState, connect, notice }} />;

  return (
    <main>
      <header className="app-header">
        <div>
          <span className={`connection ${connectionState}`}><i />{connectionState === "connected" ? "Máy chủ đã kết nối" : connectionState === "connecting" ? "Đang kết nối máy chủ" : "Mất kết nối máy chủ"}</span>
          <h1>Điều khiển nhận đơn</h1>
          <p>Zalo: <strong>{status.status}</strong> · {modeText(status)}</p>
        </div>
        <button className="icon-button" aria-label="Cài đặt kết nối" onClick={() => setPage("connection")}>⚙</button>
      </header>

      <nav className="nav-tabs" aria-label="Điều hướng">
        <button className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>Tổng quan</button>
        <button className={page === "history" ? "active" : ""} onClick={() => setPage("history")}>Lịch sử</button>
        <button className={page === "routes" ? "active" : ""} onClick={() => setPage("routes")}>Cuốc ưu tiên</button>
        <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>Cài đặt</button>
      </nav>

      {page === "dashboard" && <Dashboard {...{ status, todayCount, successfulOrders, busy, control }} />}
      {page === "history" && <History orders={orders} />}
      {page === "routes" && (
        <RoutesPage
          {...{ routes, visibleRoutes, routeSearch, setRouteSearch, routeFilter, setRouteFilter, savingRouteId }}
          onAdd={() => setRouteDraft(emptyRoute())}
          onEdit={(route) => setRouteDraft({ ...route, originAliases: route.originAliases.join(", "), destinationAliases: route.destinationAliases.join(", ") })}
          onUpdate={updateRoute}
          onDelete={deleteRoute}
          onToggleAll={toggleAll}
          onFile={previewFile}
          onBackup={downloadBackup}
        />
      )}
      {page === "settings" && (
        <>
          <ZaloLogin status={status} apiUrl={apiUrl} token={adminToken} revision={qrRevision} />
          <section className="settings panel">
            <h2>Thông báo Android</h2>
            {[["sound", "Âm thanh"], ["vibrate", "Rung"], ["speech", "Giọng đọc tiếng Việt"]].map(([key, label]) => (
              <label className="switch-row" key={key}><span>{label}</span><input type="checkbox" checked={notificationSettings[key]} onChange={(event) => setNotificationSettings((value) => ({ ...value, [key]: event.target.checked }))} /></label>
            ))}
            <label className="switch-row"><span>Nút điều khiển nổi</span><input type="checkbox" checked={overlayEnabled} onChange={() => void toggleOverlay()} /></label>
          </section>
        </>
      )}
      {page === "connection" && (
        <section className="settings panel">
          <h2>Kết nối máy chủ</h2>
          <label htmlFor="settings-url">Địa chỉ máy chủ</label>
          <input id="settings-url" placeholder={isNative ? "http://192.168.1.10:3001" : "Để trống nếu mở từ chính máy chủ"} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
          <label htmlFor="settings-token">Token quản trị</label>
          <input id="settings-token" type="password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} />
          <button className="primary" onClick={() => void connect()}>Lưu và kết nối lại</button>
        </section>
      )}

      {routeDraft && <RouteDialog draft={routeDraft} setDraft={setRouteDraft} busy={busy} onSave={saveRoute} onClose={() => setRouteDraft(null)} />}
      {importDialog && <ImportDialog data={importDialog} busy={busy} onConfirm={confirmImport} onClose={() => setImportDialog(null)} />}
      {notice && <button className="notice" onClick={() => setNotice("")}>{notice}</button>}
    </main>
  );
}

function ConnectScreen({ serverUrl, setServerUrl, adminToken, setAdminToken, connectionState, connect, notice }) {
  return (
    <main className="connect-shell"><section className="connect-card">
      <div className="brand-mark">Z</div><h1>Kết nối máy chủ</h1>
      <p>Điện thoại cùng Wi-Fi: nhập IP máy chạy backend, ví dụ <code>http://192.168.1.10:3001</code>. Token quản trị lấy từ file <code>server/.env</code>.</p>
      <label htmlFor="server-url">Địa chỉ máy chủ</label>
      <input id="server-url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder={isNative ? "http://192.168.1.10:3001" : "Để trống nếu mở từ chính máy chủ"} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
      <label htmlFor="admin-token">Token quản trị</label>
      <input id="admin-token" type="password" autoComplete="current-password" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} />
      <button className="primary large" disabled={connectionState === "connecting"} onClick={() => void connect()}>{connectionState === "connecting" ? "Đang kết nối…" : "Kết nối"}</button>
      {notice && <div className="notice inline">{notice}</div>}
    </section></main>
  );
}

function Dashboard({ status, todayCount, successfulOrders, busy, control }) {
  const latest = successfulOrders[0];
  const routeStats = status.priorityRouteStats || { enabled: 0, disabled: 0 };
  const redis = status.redis || {};
  const redisReady = redis.connected && redis.subscriberConnected !== false;
  const redisLabel = !redis.connected
    ? "Mất kết nối"
    : redis.subscriberConnected === false ? "Lệnh ổn, đồng bộ đang nối lại" : "Đã kết nối";
  return <>
    <section className={`hero-status ${status.enabled ? "running" : "stopped"}`}><span className="eyebrow">TRẠNG THÁI BOT</span><h2>{modeText(status)}</h2><p>{status.mode === "priority" ? "Chỉ phản hồi cuốc khớp tuyến ưu tiên đang bật" : "Phản hồi tất cả tin hợp lệ trong nhóm đã chọn"}</p></section>
    <section className="mode-picker panel"><h3>Chọn chế độ</h3><button className={status.mode === "all" ? "selected" : ""} disabled={busy} onClick={() => void control(status.enabled ? "start" : "stop", "all")}><strong>Nhận tất cả</strong><span>Mọi cuốc xe hợp lệ</span></button><button className={status.mode === "priority" ? "selected" : ""} disabled={busy} onClick={() => void control(status.enabled ? "start" : "stop", "priority")}><strong>Cuốc ưu tiên</strong><span>Chỉ tuyến đang bật</span></button></section>
    <section className="action-grid"><button className="start large" disabled={busy || status.enabled} onClick={() => void control("start")}>START<br /><small>Bắt đầu nhận đơn</small></button><button className="stop large" disabled={busy || !status.enabled} onClick={() => void control("stop")}>STOP<br /><small>Dừng ngay lập tức</small></button></section>
    <section className="metrics"><article><strong>{todayCount}</strong><span>Đơn hôm nay</span></article><article><strong>{latest?.totalMs ?? latest?.latencyMs ?? "--"}</strong><span>Tốc độ gần nhất (ms)</span></article><article><strong>{routeStats.enabled}</strong><span>Tuyến đang bật</span></article><article><strong>{routeStats.disabled}</strong><span>Tuyến đang tắt</span></article></section>
    <section className={`system-health panel ${redisReady ? "healthy" : "warning"}`}><div><strong>Redis: {redisLabel}</strong><span>{redis.connected ? `Phiên bản ${redis.version}` : "Bot đang dùng cấu hình gần nhất trong RAM"}</span></div><div><strong>Cập nhật cấu hình</strong><span>{formatTime(status.configUpdatedAt || redis.lastSyncedAt)}</span></div></section>
  </>;
}

function History({ orders }) {
  return <section><div className="section-heading"><div><span className="eyebrow">ĐỒNG BỘ TỪ MÁY CHỦ</span><h2>Lịch sử đơn đã gửi thành công</h2></div><span>{orders.length} bản ghi</span></div><div className="order-list">{orders.length === 0 ? <p>Chưa có đơn nào.</p> : orders.map((order) => <article className="order-card success" key={order.eventId}><div><strong>Đã nhận đơn</strong><span>{formatTime(order.sentAt)}</span></div><p>{order.originalContent}</p><small>{order.groupName} · {order.senderName} · {order.mode === "priority" ? order.matchedRoute : "Nhận tất cả"}</small><small>Chuẩn hóa {order.normalizationMs ?? 0} ms · So tuyến {order.routeMatchMs ?? 0} ms · Gọi gửi {order.dispatchMs ?? "--"} ms · Zalo {order.networkMs ?? "--"} ms · Tổng {order.totalMs ?? order.latencyMs ?? "--"} ms</small></article>)}</div></section>;
}

function RoutesPage({ routes, visibleRoutes, routeSearch, setRouteSearch, routeFilter, setRouteFilter, savingRouteId, onAdd, onEdit, onUpdate, onDelete, onToggleAll, onFile, onBackup }) {
  const allEnabled = routes.length > 0 && routes.every((route) => route.enabled);
  return <section>
    <div className="section-heading"><div><span className="eyebrow">CÀI ĐẶT</span><h2>Cuốc xe ưu tiên</h2></div><button className="primary" onClick={onAdd}>+ Thêm tuyến mới</button></div>
    <div className="route-toolbar panel"><input type="search" placeholder="Tìm điểm đi, điểm đến hoặc tên thay thế" value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} /><select value={routeFilter} onChange={(event) => setRouteFilter(event.target.value)}><option value="all">Tất cả tuyến</option><option value="enabled">Đang bật</option><option value="disabled">Đang tắt</option></select><label className="file-button">Tải file TXT<input type="file" accept=".txt,text/plain" disabled={savingRouteId === "all"} onChange={(event) => { void onFile(event.target.files?.[0]); event.target.value = ""; }} /></label><button className="secondary" onClick={() => void onBackup()}>Tải xuống bản sao</button></div>
    <label className="bulk-switch panel"><span><strong>Bật/tắt tất cả tuyến</strong><small>{routes.length} tuyến trong cấu hình</small></span><input type="checkbox" checked={allEnabled} disabled={!routes.length || savingRouteId === "all"} onChange={(event) => void onToggleAll(event.target.checked)} /></label>
    <div className="route-list">{visibleRoutes.length === 0 ? <p className="empty">Không có tuyến phù hợp.</p> : visibleRoutes.map((route) => <article className={`route-card ${route.enabled ? "enabled" : "disabled"}`} key={route.id}><div className="route-title"><strong>{route.origin} <span>→</span> {route.destination}</strong><small>{route.twoWay ? "Nhận hai chiều" : "Chỉ nhận một chiều"} · Cập nhật {formatTime(route.updatedAt)}</small>{(route.originAliases.length > 0 || route.destinationAliases.length > 0) && <small>Tên thay thế: {[...route.originAliases, ...route.destinationAliases].join(", ")}</small>}{route.sourceFile && <small>Nguồn: {route.sourceFile} · tải lên {formatTime(route.uploadedAt)} · {route.importRouteCount} tuyến hợp lệ</small>}</div><div className="route-actions"><label><span>Hai chiều</span><input type="checkbox" checked={route.twoWay} disabled={savingRouteId === route.id} onChange={(event) => void onUpdate(route, { twoWay: event.target.checked })} /></label><label><span>{route.enabled ? "Đang bật" : "Đang tắt"}</span><input type="checkbox" checked={route.enabled} disabled={savingRouteId === route.id} onChange={(event) => void onUpdate(route, { enabled: event.target.checked })} /></label><button className="secondary compact" onClick={() => onEdit(route)}>Sửa</button><button className="danger compact" onClick={() => void onDelete(route)}>Xóa</button></div>{savingRouteId === route.id && <span className="saving">Đang lưu trên máy chủ…</span>}</article>)}</div>
  </section>;
}

function RouteDialog({ draft, setDraft, busy, onSave, onClose }) {
  const field = (key) => (event) => setDraft((value) => ({ ...value, [key]: event.target.value }));
  return <div className="modal-backdrop"><section className="modal"><div className="section-heading"><h2>{draft.id ? "Chỉnh sửa tuyến" : "Thêm tuyến mới"}</h2><button className="icon-button" onClick={onClose}>×</button></div><label>Điểm đi</label><input value={draft.origin} onChange={field("origin")} placeholder="Ví dụ: Bắc Ninh" /><label>Điểm đến</label><input value={draft.destination} onChange={field("destination")} placeholder="Ví dụ: Hà Nội" /><label>Tên thay thế của điểm đi</label><textarea value={draft.originAliases} onChange={field("originAliases")} placeholder="BN, TP Bắc Ninh" /><label>Tên thay thế của điểm đến</label><textarea value={draft.destinationAliases} onChange={field("destinationAliases")} placeholder="HN, thành phố Hà Nội" /><label className="switch-row"><span>Nhận hai chiều</span><input type="checkbox" checked={draft.twoWay} onChange={(event) => setDraft((value) => ({ ...value, twoWay: event.target.checked }))} /></label><label className="switch-row"><span>Bật tuyến ngay</span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))} /></label><div className="form-actions"><button className="secondary" onClick={onClose}>Hủy</button><button className="primary" disabled={busy || !draft.origin.trim() || !draft.destination.trim()} onClick={() => void onSave()}>{busy ? "Đang lưu…" : "Lưu trên máy chủ"}</button></div></section></div>;
}

function ImportDialog({ data, busy, onConfirm, onClose }) {
  const { preview } = data;
  const hasErrors = preview.errors.length > 0;
  return <div className="modal-backdrop"><section className="modal wide"><div className="section-heading"><div><span className="eyebrow">XEM TRƯỚC FILE TXT</span><h2>{data.fileName}</h2></div><button className="icon-button" onClick={onClose}>×</button></div><div className="preview-summary"><strong>{preview.routes.length} tuyến mới</strong><span>{preview.duplicates.length} tuyến trùng</span><span className={hasErrors ? "error-text" : ""}>{preview.errors.length} dòng lỗi</span></div>{hasErrors && <div className="error-list">{preview.errors.map((error) => <p key={`${error.line}-${error.reason}`}><strong>Dòng {error.line}:</strong> {error.reason} <code>{error.content}</code></p>)}</div>}<div className="preview-list">{preview.routes.map((route) => <p key={route.id}>{route.origin} <strong>↔</strong> {route.destination}</p>)}</div>{preview.duplicates.length > 0 && <details><summary>Tuyến trùng đã bỏ qua</summary>{preview.duplicates.map((item) => <p key={`${item.line}-${item.content}`}>Dòng {item.line}: {item.content}</p>)}</details>}<div className="form-actions"><button className="secondary" onClick={onClose}>Hủy</button><button className="primary" disabled={busy || hasErrors || preview.routes.length === 0} onClick={() => void onConfirm()}>{busy ? "Đang nhập…" : "Xác nhận nhập"}</button></div></section></div>;
}

function ZaloLogin({ status, apiUrl, token, revision }) {
  const labels = {
    online: "Đã đăng nhập",
    qr_required: "Chờ quét QR",
    connecting: "Đang kết nối",
    reconnecting: "Đang kết nối lại",
    offline: "Chưa đăng nhập",
    error: "Lỗi kết nối",
  };
  return <section className="settings panel zalo-login">
    <div className="section-heading">
      <div><span className="eyebrow">TÀI KHOẢN</span><h2>Đăng nhập Zalo</h2></div>
      <span className={`zalo-login-status ${status.status}`}>{labels[status.status] || status.status}</span>
    </div>
    {status.qrAvailable
      ? <QrCode apiUrl={apiUrl} token={token} revision={revision} />
      : status.status === "online"
        ? <p className="zalo-login-success">✓ Zalo đã đăng nhập và đang duy trì kết nối.</p>
        : <p className="muted">Máy chủ đang tạo mã QR. Mã sẽ tự xuất hiện tại đây khi sẵn sàng.</p>}
  </section>;
}

function QrCode({ apiUrl, token, revision }) {
  const [source, setSource] = React.useState("");
  const [loadState, setLoadState] = React.useState("loading");
  const [reloadKey, setReloadKey] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setSource("");
    setLoadState("loading");
    const cacheKey = revision || String(Date.now());
    fetch(`${apiUrl("/api/zalo/qr")}?v=${encodeURIComponent(cacheKey)}`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    })
      .then((response) => { if (!response.ok) throw new Error("QR chưa sẵn sàng"); return response.blob(); })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
        setLoadState("ready");
      })
      .catch(() => { if (!cancelled) setLoadState("error"); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiUrl, token, revision, reloadKey]);
  return <div className="qr-card">
    <h3>Quét QR bằng ứng dụng Zalo</h3>
    {source && <img src={source} alt="Mã QR đăng nhập Zalo" />}
    {loadState === "loading" && <p className="muted">Đang tải mã QR mới…</p>}
    {loadState === "error" && <p className="error-text">Chưa tải được mã QR.</p>}
    <p className="muted">Mở Zalo trên điện thoại → Quét mã QR → Xác nhận đăng nhập.</p>
    <button className="secondary" onClick={() => setReloadKey((value) => value + 1)}>Lấy mã QR mới nhất</button>
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
