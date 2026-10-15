import { useState } from "react";
import { api } from "./api.js";

export default function Login({ onLogin, notice }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!token.trim()) return setError("Pega tu token para continuar.");
    setBusy(true);
    setError("");
    try {
      const d = await api("POST", "/api/login", { token: token.trim() });
      setToken(""); // el token no se queda en memoria de la página
      onLogin(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <span className="logo big">G</span>
        <h1>Portal Claude</h1>
        <p className="muted">Ingresa el token que te asignaron para usar las tareas con Claude.</p>
        {notice && <div className="alert warn">{notice}</div>}
        <label htmlFor="tk">Token de acceso</label>
        <input
          id="tk"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="gbl_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error && <div className="alert err" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? "Verificando…" : "Ingresar"}</button>
      </form>
    </div>
  );
}
