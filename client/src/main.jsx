import React from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import "./styles.css";

const socket = io();

function App() {
  const [status, setStatus] = React.useState(null);
  const [activity, setActivity] = React.useState([]);
  const [adminKey, setAdminKey] = React.useState("");
  const [page, setPage] = React.useState("dashboard");
  const [selectedFile, setSelectedFile] = React.useState(null);
  const [routeName, setRouteName] = React.useState("");
  const [showNewRoute, setShowNewRoute] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/status").then((response) => response.json()).then(setStatus);
    const onStatus = (next) => setStatus(next);
    const onActivity = (item) => setActivity((items) => [item, ...items].slice(0, 20));
    socket.on("status", onStatus);
    socket.on("activity", onActivity);
    return () => {
      socket.off("status", onStatus);
      socket.off("activity", onActivity);
    };
  }, []);

  async function saveSetting(endpoint, body, method = "POST") {
    const response = await fetch(endpoint, {
      method,
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? "ADMIN_KEY khong dung" : result.error || "Khong the luu cai dat");
    setStatus(result);
    return result;
  }

  async function toggle(endpoint, enabled) {
    setNotice("");
    try {
      await saveSetting(endpoint, { enabled });
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function createRoute() {
    if (!routeName.trim()) {
      setNotice("Hay nhap ten tuyen");
      return;
    }
    if (!selectedFile) {
      setNotice("Hay chon mot file .txt");
      return;
    }
    if (!selectedFile.name.toLowerCase().endsWith(".txt")) {
      setNotice("Chi chap nhan file .txt");
      return;
    }

    setSaving(true);
    setNotice("");
    try {
      const content = await selectedFile.text();
      const next = await saveSetting("/api/settings/priority-routes", {
        name: routeName,
        fileName: selectedFile.name,
        content,
      });
      setNotice(`Da luu tuyen ${routeName} voi ${next.priorityLocationsConfigured} vi tri dang bat`);
      setSelectedFile(null);
      setRouteName("");
      setShowNewRoute(false);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRoute(route) {
    setNotice("");
    try {
      await saveSetting(`/api/settings/priority-routes/${route.id}`, { enabled: !route.enabled }, "PATCH");
    } catch (error) {
      setNotice(error.message);
    }
  }

  function cancelNewRoute() {
    setRouteName("");
    setSelectedFile(null);
    setShowNewRoute(false);
    setNotice("");
  }

  if (!status) return <main><p>&#272;ang k&#7871;t n&#7889;i...</p></main>;

  return (
    <main>
      <header>
        <div><span className={`dot ${status.status}`} />{status.status}</div>
        <h1>Zalo Auto Reply</h1>
        <p>Ph&#7843;n h&#7891;i &ldquo;{status.replyText}&rdquo; theo s&#7921; ki&#7879;n, kh&#244;ng polling.</p>
      </header>

      <nav className="nav-tabs" aria-label="Dieu huong">
        <button className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>T&#7893;ng quan</button>
        <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>C&#224;i &#273;&#7863;t</button>
      </nav>

      {page === "dashboard" ? (
        <>
          <section className="metrics">
            <article><strong>{status.groupsConfigured}</strong><span>Nh&#243;m c&#7845;u h&#236;nh</span></article>
            <article><strong>{status.stats.sent}</strong><span>&#272;&#227; g&#7917;i</span></article>
            <article><strong>{status.stats.failed}</strong><span>G&#7917;i l&#7895;i</span></article>
            <article><strong>{status.stats.lastDispatchMs ?? "--"}</strong><span>X&#7917; l&#253; n&#7897;i b&#7897; (ms)</span></article>
            <article><strong>{status.stats.lastNetworkMs ?? "--"}</strong><span>M&#7841;ng/Zalo (ms)</span></article>
            <article><strong>{status.stats.lastLatencyMs ?? "--"}</strong><span>Latency g&#7847;n nh&#7845;t (ms)</span></article>
          </section>
          <section className="control">
            <button className={status.enabled ? "stop" : "start"} onClick={() => toggle("/api/bot/enabled", !status.enabled)}>
              {status.enabled ? "Tam dung bot" : "Bat bot"}
            </button>
          </section>
          <section>
            <h2>Ho&#7841;t &#273;&#7897;ng g&#7847;n &#273;&#226;y</h2>
            {activity.length === 0 ? <p className="muted">Ch&#432;a c&#243; tin nh&#7855;n &#273;&#227; g&#7917;i.</p> : activity.map((item) => (
              <div className="event" key={`${item.groupId}-${item.at}`}>
                <code>{item.groupId}</code>
                <span>X&#7917; l&#253; {item.dispatchMs ?? "--"} ms / M&#7841;ng {item.networkMs ?? "--"} ms</span>
              </div>
            ))}
          </section>
        </>
      ) : (
        <section className="settings">
          <h2>C&#224;i &#273;&#7863;t cu&#7889;c xe &#432;u ti&#234;n</h2>
          <label className="field-label" htmlFor="admin-key">Kh&#243;a qu&#7843;n tr&#7883;</label>
          <input id="admin-key" type="password" placeholder="ADMIN_KEY" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} />

          <div className="setting-row">
            <div>
              <strong>Ch&#7881; nh&#7853;n cu&#7889;c &#432;u ti&#234;n</strong>
              <p className="muted">Khi b&#7853;t, bot ch&#7881; tr&#7843; l&#7901;i tin c&#243; &#273;&#7883;a &#273;i&#7875;m trong file.</p>
            </div>
            <button className={status.priorityOnly ? "stop" : "start"} onClick={() => toggle("/api/bot/priority-only", !status.priorityOnly)}>
              {status.priorityOnly ? "Dang bat" : "Dang tat"}
            </button>
          </div>

          <div className="routes-header">
            <div>
              <strong>C&#225;c tuy&#7871;n &#432;u ti&#234;n</strong>
              <p className="muted">{status.priorityLocationsConfigured} &#273;&#7883;a &#273;i&#7875;m thu&#7897;c c&#225;c tuy&#7871;n &#273;ang b&#7853;t.</p>
            </div>
            {!showNewRoute && <button className="start" onClick={() => setShowNewRoute(true)}>+ Th&#234;m m&#7899;i</button>}
          </div>

          {showNewRoute && (
            <div className="upload-box">
              <strong>Th&#234;m tuy&#7871;n m&#7899;i</strong>
              <label className="field-label" htmlFor="route-name">T&#234;n tuy&#7871;n</label>
              <input id="route-name" type="text" maxLength="100" placeholder="V&#237; d&#7909;: B&#7855;c Ninh -> H&#224; N&#7897;i" value={routeName} onChange={(event) => setRouteName(event.target.value)} />
              <label className="field-label" htmlFor="route-file">File &#273;&#7883;a &#273;i&#7875;m (.txt)</label>
              <input id="route-file" type="file" accept=".txt,text/plain" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
              <div className="form-actions">
                <button className="secondary" disabled={saving} onClick={cancelNewRoute}>H&#7911;y</button>
                <button className="start" disabled={saving || !selectedFile || !routeName.trim()} onClick={createRoute}>
                  {saving ? "\u0110ang l\u01b0u..." : "L\u01b0u"}
                </button>
              </div>
            </div>
          )}

          <div className="route-list">
            {(status.priorityRoutes || []).length === 0 ? (
              <p className="muted">Ch&#432;a c&#243; tuy&#7871;n &#432;u ti&#234;n n&#224;o.</p>
            ) : status.priorityRoutes.map((route) => (
              <article className={`route-card ${route.enabled ? "enabled" : ""}`} key={route.id}>
                <div>
                  <strong>{route.name}</strong>
                  <span>{route.fileName} &middot; {route.locationCount} &#273;&#7883;a &#273;i&#7875;m</span>
                </div>
                <button className={route.enabled ? "enabled-toggle" : "disabled-toggle"} onClick={() => toggleRoute(route)}>
                  {route.enabled ? "B\u1eadt" : "T\u1eaft"}
                </button>
              </article>
            ))}
          </div>
          <p className="muted">&#272;&#227; b&#7887; qua {status.stats.prioritySkipped} tin kh&#244;ng ph&#249; h&#7907;p.</p>
        </section>
      )}

      {notice && <div className="notice" role="status">{notice}</div>}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
