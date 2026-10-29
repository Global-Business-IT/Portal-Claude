import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import Login from "./Login.jsx";
import Bienvenida from "./Bienvenida.jsx";
import Portal from "./Portal.jsx";
import Admin from "./Admin.jsx";

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = cargando, null = sin sesión
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("tasks");
  const [entered, setEntered] = useState(false); // acceso abierto: ya pulsó "Iniciar sesión con Microsoft"
  const [adminLogin, setAdminLogin] = useState(false); // acceso abierto: entrar como administrador

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
    setAdminLogin(false);
    setEntered(false);
    // Con acceso abierto, al salir se vuelve a entrar como invitado.
    api("GET", "/api/me").then(setMe).catch(() => setMe(null));
  };

  if (me === undefined) return <div className="center muted">Cargando…</div>;
  if (me === null || adminLogin)
    return (
      <Login
        notice={notice}
        onLogin={(d) => {
          setNotice("");
          setAdminLogin(false);
          refreshUsage();
          setMe({ user: d.user, usage: null });
        }}
      />
    );

  if (me.user.guest && !entered)
    return <Bienvenida onEnter={() => setEntered(true)} onToken={() => setAdminLogin(true)} />;

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
          {me.user.guest ? (
            <button className="ghost" onClick={() => setAdminLogin(true)}>Ingresar con token</button>
          ) : (
            <button className="ghost" onClick={logout}>Salir</button>
          )}
        </div>
      </header>
      <main className="main">
        {view === "admin" && isAdmin ? (
          <Admin onAuthLost={onAuthLost} />
        ) : (
          <Portal
            onAuthLost={onAuthLost}
            onRan={refreshUsage}
            guest={Boolean(me.user.guest)}
            onLoggedIn={(d) => {
              refreshUsage();
              setMe({ user: d.user, usage: null });
            }}
          />
        )}
      </main>
    </div>
  );
}
