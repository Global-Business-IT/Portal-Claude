import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import Login from "./Login.jsx";
import Portal from "./Portal.jsx";
import Admin from "./Admin.jsx";

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = cargando, null = sin sesión
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("tasks");

  useEffect(() => {
    api("GET", "/api/me")
      .then((d) => setMe(d))
      .catch(() => setMe(null));
  }, []);

  const refreshUsage = useCallback(() => {
    api("GET", "/api/me").then(setMe).catch(() => {});
  }, []);

  // Cualquier 401 en el portal devuelve al acceso con un mensaje claro.
  const onAuthLost = useCallback((err) => {
    setNotice(
      err?.code === "revoked"
        ? "Tu token fue revocado. Solicita uno nuevo al administrador."
        : "Tu sesión expiró. Ingresa de nuevo con tu token."
    );
    setMe(null);
  }, []);

  const logout = async () => {
    await api("POST", "/api/logout").catch(() => {});
    setNotice("");
    setView("tasks");
    setMe(null);
  };

  if (me === undefined) return <div className="center muted">Cargando…</div>;
  if (me === null)
    return (
      <Login
        notice={notice}
        onLogin={(d) => {
          setNotice("");
          refreshUsage();
          setMe({ user: d.user, usage: null });
        }}
      />
    );

  const isAdmin = me.user.role === "admin";
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="logo">G</span>
          <strong>Portal Claude</strong>
        </div>
        {isAdmin && (
          <nav className="tabs">
            <button className={view === "tasks" ? "on" : ""} onClick={() => setView("tasks")}>Tareas</button>
            <button className={view === "admin" ? "on" : ""} onClick={() => setView("admin")}>Administración</button>
          </nav>
        )}
        <div className="who">
          {me.usage && (
            <span className="pill" title="Tareas ejecutadas hoy / límite diario">
              Hoy {me.usage.used}/{me.usage.limit}
            </span>
          )}
          <span className="muted hide-sm">{me.user.name}</span>
          <button className="ghost" onClick={logout}>Salir</button>
        </div>
      </header>
      <main className="main">
        {view === "admin" && isAdmin ? (
          <Admin onAuthLost={onAuthLost} />
        ) : (
          <Portal onAuthLost={onAuthLost} onRan={refreshUsage} />
        )}
      </main>
    </div>
  );
}
