import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const STATUS = { active: "Activo", revoked: "Revocado", expired: "Expirado" };
const RUN_STATUS = { ok: "OK", error: "Error", rejected: "Rechazada", cancelled: "Cancelada" };
const TASK_NAME = { summarize: "Resumir", email: "Correo", analyze: "Analizar", translate: "Traducir" };
const fmt = (s) => (s ? new Date(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z")).toLocaleString("es") : "—");

export default function Admin({ onAuthLost }) {
  const [tokens, setTokens] = useState([]);
  const [runs, setRuns] = useState([]);
  const [tab, setTab] = useState("tokens");
  const [skills, setSkills] = useState([]);
  const [restrictedOk, setRestrictedOk] = useState(false);
  const [sync, setSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [fresh, setFresh] = useState(null); // token recién emitido (se muestra una sola vez)
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", role: "user", dailyLimit: 50, expiresInDays: "" });

  const guard = useCallback(
    (e) => (e.status === 401 ? onAuthLost(e) : setErr(e.message)),
    [onAuthLost]
  );
  const load = useCallback(() => {
    api("GET", "/api/admin/tokens").then((d) => setTokens(d.tokens)).catch(guard);
    api("GET", "/api/admin/skills").then((d) => { setSkills(d.skills); setSync(d.sync); setRestrictedOk(Boolean(d.restrictedAvailable)); }).catch(guard);
    api("GET", "/api/admin/runs?limit=200").then((d) => setRuns(d.runs)).catch(guard);
  }, [guard]);
  useEffect(load, [load]);

  const act = async (fn, label) => {
    setErr("");
    try {
      const r = await fn();
      if (r?.token) setFresh({ token: r.token, label });
      load();
    } catch (e) {
      guard(e);
    }
  };

  const create = (e) => {
    e.preventDefault();
    act(
      () =>
        api("POST", "/api/admin/tokens", {
          ...form,
          dailyLimit: Number(form.dailyLimit),
          expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null,
        }),
      form.name
    ).then(() => setForm({ name: "", role: "user", dailyLimit: 50, expiresInDays: "" }));
  };

  const patchSkill = (s, patch) => {
    if (patch.scriptsMode === 1 && !window.confirm(`¿Permitir que "${s.name}" ejecute scripts en un entorno aislado? Revisa antes el código en el repositorio.`)) return;
    if (patch.scriptsMode === 2 && !window.confirm(`Modo restringido para "${s.name}": sus scripts se ejecutan SIN aislamiento del sistema. Solo se permite lanzar los scripts de la propia skill (sin encadenar comandos y con archivos dentro de la carpeta de trabajo). Revisa antes el código de esos scripts en el repositorio. ¿Continuar?`)) return;
    act(() => api("PATCH", `/api/admin/skills/${s.name}`, patch));
  };
  const syncNow = async () => {
    setSyncing(true);
    await act(async () => { const r = await api("POST", "/api/admin/skills/sync"); setSync(r.sync); });
    setSyncing(false);
  };

  const changeLimit = (t) => {
    const v = window.prompt(`Nuevo límite diario para ${t.name}:`, t.dailyLimit);
    if (v && Number(v) > 0) act(() => api("PATCH", `/api/admin/tokens/${t.id}`, { dailyLimit: Number(v) }));
  };

  return (
    <div className="admin">
      <nav className="tabs sub">
        <button className={tab === "tokens" ? "on" : ""} onClick={() => setTab("tokens")}>Tokens</button>
        <button className={tab === "skills" ? "on" : ""} onClick={() => setTab("skills")}>Skills</button>
        <button className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>Registro de uso</button>
      </nav>
      {err && <div className="alert err">{err}</div>}

      {fresh && (
        <div className="alert ok">
          <strong>Token de {fresh.label}</strong> — cópialo ahora, no se volverá a mostrar:
          <code className="tokenview">{fresh.token}</code>
          <div className="row">
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(fresh.token)}>Copiar</button>
            <button className="ghost" onClick={() => setFresh(null)}>Ya lo guardé</button>
          </div>
        </div>
      )}

      {tab === "tokens" && (
        <>
          <form className="card inline" onSubmit={create}>
            <h3>Crear token</h3>
            <div className="formrow">
              <div className="field"><label htmlFor="n">Nombre</label>
                <input id="n" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="r">Rol</label>
                <select id="r" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="user">Usuario</option><option value="admin">Administrador</option></select></div>
              <div className="field"><label htmlFor="l">Tareas por día</label>
                <input id="l" type="number" min="1" max="5000" value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: e.target.value })} /></div>
              <div className="field"><label htmlFor="d">Vence en (días)</label>
                <input id="d" type="number" min="1" placeholder="Sin vencimiento" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })} /></div>
            </div>
            <button className="primary">Crear token</button>
          </form>

          <div className="card tablewrap">
            <table>
              <thead><tr><th>Nombre</th><th>Rol</th><th>Token</th><th>Estado</th><th>Hoy</th><th>Vence</th><th>Último uso</th><th /></tr></thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className={t.status !== "active" ? "dim" : ""}>
                    <td>{t.name}</td>
                    <td>{t.role === "admin" ? "Admin" : "Usuario"}</td>
                    <td><code>{t.hint}</code></td>
                    <td><span className={`badge ${t.status}`}>{STATUS[t.status]}</span></td>
                    <td>{t.usedToday}/{t.dailyLimit}</td>
                    <td>{t.expiresAt ? fmt(t.expiresAt) : "—"}</td>
                    <td>{fmt(t.lastUsedAt)}</td>
                    <td className="actions">
                      {t.status === "active" && <button className="ghost" onClick={() => changeLimit(t)}>Límite</button>}
                      <button className="ghost" onClick={() => window.confirm(`¿Renovar el token de ${t.name}? El anterior dejará de funcionar.`) && act(() => api("POST", `/api/admin/tokens/${t.id}/renew`), t.name)}>Renovar</button>
                      {t.status === "active" && (
                        <button className="ghost danger" onClick={() => window.confirm(`¿Revocar el token de ${t.name}? Perderá el acceso de inmediato.`) && act(() => api("POST", `/api/admin/tokens/${t.id}/revoke`))}>Revocar</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "skills" && (
        <>
          <div className="card">
            <div className="row between">
              <div>
                <h3>Repositorio de skills</h3>
                {!sync?.configured && <p className="muted">No configurado: falta SKILLS_REPO_URL en el archivo .env del servidor.</p>}
                {sync?.configured && (
                  <p className="muted small">
                    Última sincronización: {sync.at ? fmt(sync.at) : "nunca"} {sync.sha && <>· commit <code>{sync.sha}</code></>} · motivo: {sync.reason || "—"} · {sync.count} skill(s) válidas
                  </p>
                )}
              </div>
              <button className="primary" onClick={syncNow} disabled={syncing || !sync?.configured}>{syncing ? "Sincronizando…" : "Sincronizar ahora"}</button>
            </div>
            {sync?.error && <div className="alert err">No se pudo sincronizar: {sync.error}. Se siguen usando las skills de la última copia buena.</div>}
            {sync?.warnings?.length > 0 && (
              <div className="alert warn"><strong>Avisos del repositorio:</strong>
                <ul>{sync.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
            )}
          </div>
          <div className="card tablewrap">
            <table>
              <thead><tr><th>Skill</th><th>Descripción</th><th>Commit</th><th>Activa</th><th>Scripts</th></tr></thead>
              <tbody>
                {skills.map((s) => (
                  <tr key={s.name} className={!s.present ? "dim" : ""}>
                    <td><strong>{s.name}</strong>{!s.present && <div className="muted small">Ya no está en el repositorio</div>}{s.present && !s.enabled && <div className="muted small">Nueva: pendiente de activar</div>}</td>
                    <td className="desc">{s.description}</td>
                    <td><code>{s.commit || "—"}</code></td>
                    <td><label className="switch"><input type="checkbox" checked={s.enabled} disabled={!s.present} onChange={(e) => patchSkill(s, { enabled: e.target.checked })} /> {s.enabled ? "Sí" : "No"}</label></td>
                    <td>
                      {s.hasScripts ? (
                        <select value={s.scriptsMode} onChange={(e) => patchSkill(s, { scriptsMode: Number(e.target.value) })}>
                          <option value={0}>Bloqueados</option>
                          <option value={1}>Aislados (sandbox)</option>
                          {(restrictedOk || s.scriptsMode === 2) && <option value={2} disabled={!restrictedOk}>Restringidos (sin aislamiento)</option>}
                        </select>
                      ) : <span className="muted">No trae</span>}
                    </td>
                  </tr>
                ))}
                {!skills.length && <tr><td colSpan="5" className="muted">Aún no hay skills. Sincroniza el repositorio o agrega skills en <code>.claude/skills/</code>.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "runs" && (
        <div className="card tablewrap">
          <table>
            <thead><tr><th>Fecha</th><th>Usuario</th><th>Tarea</th><th>Estado</th><th>Duración</th><th>Costo est.</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmt(r.created_at)}</td><td>{r.user_name}</td><td>{r.task.startsWith("skill:") ? "Skill · " + r.task.slice(6) : TASK_NAME[r.task] || r.task}</td>
                  <td><span className={`badge ${r.status}`}>{RUN_STATUS[r.status] || r.status}</span>{r.error_code ? <span className="muted"> · {r.error_code}</span> : null}</td>
                  <td>{r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + " s" : "—"}</td>
                  <td>{r.cost_usd != null ? "$" + r.cost_usd.toFixed(3) : "—"}</td>
                </tr>
              ))}
              {!runs.length && <tr><td colSpan="6" className="muted">Aún no hay ejecuciones.</td></tr>}
            </tbody>
          </table>
          <p className="muted small">El registro guarda quién, qué tarea y cuándo. No guarda tokens ni el contenido de las tareas.</p>
        </div>
      )}
    </div>
  );
}
