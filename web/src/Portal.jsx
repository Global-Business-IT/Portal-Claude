import { Fragment, useEffect, useRef, useState } from "react";
import { api, streamRun, ApiError } from "./api.js";
import Markdown from "./Markdown.jsx";

const MAX_MB = 10;
const MAX_FILES = 5;
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

export default function Portal({ onAuthLost, onRan }) {
  const [tasks, setTasks] = useState(null);
  const [current, setCurrent] = useState(null);
  // Los datos de cada tarea se conservan al cambiar de una a otra y ante errores.
  const [forms, setForms] = useState({});
  const [files, setFiles] = useState({});
  const [out, setOut] = useState({}); // por tarea: { text, status, error }
  const [fileReset, setFileReset] = useState(0); // fuerza a vaciar el selector de archivos al pulsar "Quitar"
  const abortRef = useRef(null);

  useEffect(() => {
    Promise.all([api("GET", "/api/tasks"), api("GET", "/api/skills").catch(() => ({ skills: [] }))])
      .then(([d, s]) => {
        const skills = s.skills.map((k) => ({
          id: "skill:" + k.name, kind: "skill", skill: k.name, title: k.name, description: k.description, needs: "textOrFile",
          fields: [{ name: "text", label: "¿Qué necesitas?", type: "textarea" }, { name: "files", label: `Archivos (opcional, hasta ${MAX_FILES}, ${MAX_MB} MB c/u)`, type: "files" }],
        }));
        setTasks([...d.tasks, ...skills]);
        setCurrent(d.tasks[0]?.id);
      })
      .catch((e) => (e.status === 401 ? onAuthLost(e) : setTasks([])));
    return () => abortRef.current?.abort();
  }, [onAuthLost]);

  if (!tasks) return <p className="muted">Cargando tareas…</p>;
  const task = tasks.find((t) => t.id === current);
  if (!task) return <p className="muted">No hay tareas disponibles.</p>;

  const values = forms[task.id] || {};
  const isSkill = task.kind === "skill";
  const file = (!isSkill && files[task.id]) || null;
  const fileList = (isSkill && files[task.id]) || [];
  const res = out[task.id] || { text: "", status: "idle" };
  const running = res.status === "running";

  const setVal = (name, v) => setForms((f) => ({ ...f, [task.id]: { ...f[task.id], [name]: v } }));
  const setRes = (patch) => setOut((o) => ({ ...o, [task.id]: { ...(o[task.id] || { text: "" }), ...patch } }));

  const valueOf = (f) => values[f.name] ?? f.default ?? "";

  const validate = () => {
    const text = (values.text || "").trim();
    if (task.needs === "text" && !text) return "Escribe el texto para esta tarea.";
    if (task.needs === "file" && (!file || !text)) return "Sube un archivo y escribe qué quieres saber o extraer.";
    if (task.needs === "textOrFile" && !text && !file && !fileList.length) return "Pega un texto o sube un archivo.";
    return "";
  };

  const run = async (e) => {
    e.preventDefault();
    const problem = validate();
    if (problem) return setRes({ status: "error", error: problem, text: "" });

    const form = new FormData();
    if (isSkill) {
      form.set("skill", task.skill);
      form.set("text", (values.text || "").trim());
      fileList.forEach((f) => form.append("files", f));
    } else {
      form.set("task", task.id);
      form.set("fields", JSON.stringify(Object.fromEntries(task.fields.filter((f) => f.type !== "file").map((f) => [f.name, valueOf(f)]))));
      if (file) form.set("file", file);
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setRes({ status: "running", text: "", error: "", step: "", files: [] });
    const id = task.id;
    let acc = "";
    try {
      let outFiles = [];
      await streamRun(form, {
        signal: ac.signal,
        url: isSkill ? "/api/skills/run" : "/api/run",
        onStatus: (v) => setOut((o) => ({ ...o, [id]: { ...o[id], step: v } })),
        onFiles: (fl) => {
          outFiles = fl;
          setOut((o) => ({ ...o, [id]: { ...o[id], files: fl } }));
        },
        onText: (t) => {
          acc += t;
          setOut((o) => ({ ...o, [id]: { ...o[id], text: acc, status: "running" } }));
        },
      });
      setOut((o) => ({ ...o, [id]: { text: acc, status: "done", error: "", files: outFiles } }));
    } catch (err) {
      if (err.name === "AbortError") {
        setOut((o) => ({ ...o, [id]: { ...o[id], text: acc, status: "stopped", error: "" } }));
      } else if (err instanceof ApiError && err.status === 401) {
        onAuthLost(err);
        return;
      } else {
        setOut((o) => ({ ...o, [id]: { ...o[id], text: acc, status: "error", error: err.message } }));
      }
    } finally {
      onRan();
    }
  };

  const pickFile = (f) => {
    if (f && f.size > MAX_MB * 1024 * 1024) {
      setRes({ status: "error", error: `El archivo supera el máximo de ${MAX_MB} MB.`, text: "" });
      return;
    }
    setFiles((s) => ({ ...s, [task.id]: f }));
  };

  const pickFiles = (list) => {
    const arr = Array.from(list || []);
    if (arr.length > MAX_FILES) return setRes({ status: "error", error: `Máximo ${MAX_FILES} archivos.`, text: "" });
    if (arr.some((f) => f.size > MAX_MB * 1024 * 1024)) return setRes({ status: "error", error: `Cada archivo debe pesar menos de ${MAX_MB} MB.`, text: "" });
    setFiles((s) => ({ ...s, [task.id]: arr }));
  };

  return (
    <div className="grid">
      <aside className="list" aria-label="Tareas">
        {tasks.map((t, i) => (
          <Fragment key={t.id}>
          {t.kind === "skill" && tasks[i - 1]?.kind !== "skill" && <h4 className="listhead">Skills de la empresa</h4>}
          <button className={`task ${t.id === current ? "on" : ""}`} onClick={() => setCurrent(t.id)} disabled={running && t.id !== current}>
            <strong>{t.title}</strong>
            <span className="muted">{t.description}</span>
          </button>
          </Fragment>
        ))}
      </aside>

      <section>
        <form className="card" onSubmit={run}>
          <h2>{task.title}</h2>
          {task.fields.map((f) => (
            <div className="field" key={f.name}>
              <label htmlFor={`${task.id}-${f.name}`}>{f.label}</label>
              {f.type === "textarea" && (
                <textarea id={`${task.id}-${f.name}`} rows={7} value={values[f.name] ?? ""} onChange={(e) => setVal(f.name, e.target.value)} disabled={running} />
              )}
              {f.type === "text" && (
                <input id={`${task.id}-${f.name}`} value={values[f.name] ?? ""} onChange={(e) => setVal(f.name, e.target.value)} disabled={running} />
              )}
              {f.type === "select" && (
                <select id={`${task.id}-${f.name}`} value={valueOf(f)} onChange={(e) => setVal(f.name, e.target.value)} disabled={running}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              {f.type === "files" && (
                <div className="filebox">
                  <input id={`${task.id}-${f.name}`} type="file" multiple key={fileReset} onChange={(e) => pickFiles(e.target.files)} disabled={running} />
                  {fileList.length > 0 && (
                    <button type="button" className="ghost" onClick={() => { pickFiles([]); setFileReset((n) => n + 1); }} disabled={running}>
                      Quitar {fileList.length} archivo(s)
                    </button>
                  )}
                  {fileList.length > 0 && <ul className="small muted" style={{ flexBasis: "100%", margin: 0 }}>{fileList.map((f) => <li key={f.name}>{f.name} ({fmtSize(f.size)})</li>)}</ul>}
                </div>
              )}
              {f.type === "file" && (
                <div className="filebox">
                  <input
                    id={`${task.id}-${f.name}`}
                    type="file"
                    accept=".pdf,.txt,.csv,.md,.xlsx,.json"
                    key={fileReset}
                    onChange={(e) => pickFile(e.target.files[0] || null)}
                    disabled={running}
                  />
                  {file && (
                    <button type="button" className="ghost" onClick={() => { pickFile(null); setFileReset((n) => n + 1); }} disabled={running}>
                      Quitar {file.name}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="row">
            <button className="primary" disabled={running}>{running ? "Ejecutando…" : "Ejecutar tarea"}</button>
            {running && (
              <button type="button" className="ghost" onClick={() => abortRef.current?.abort()}>Detener</button>
            )}
          </div>
        </form>

        <Result res={res} title={task.title} />
      </section>
    </div>
  );
}

function Result({ res, title }) {
  const [copied, setCopied] = useState(false);
  if (res.status === "idle" && !res.text) return null;
  const showText = true;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(res.text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = res.text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([res.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card result" aria-live="polite">
      <div className="row between">
        <h3>Resultado</h3>
        {res.text && res.status !== "running" && (
          <div className="row">
            <button className="ghost" onClick={copy}>{copied ? "¡Copiado!" : "Copiar"}</button>
            <button className="ghost" onClick={download}>Descargar</button>
          </div>
        )}
      </div>
      {res.status === "error" && <div className="alert err" role="alert">{res.error}</div>}
      {res.status === "stopped" && <div className="alert warn">Detuviste la ejecución. Esto es lo que alcanzó a generarse.</div>}
      {res.text && (res.status === "running"
        ? <div className="output">{res.text}<span className="caret" /></div>
        : <div className="output rich"><Markdown text={res.text} /></div>)}
      {res.status === "running" && res.step && <p className="muted">{res.step}</p>}
      {res.status === "running" && !res.text && !res.step && <p className="muted">Claude está trabajando…</p>}
      {res.files?.length > 0 && (
        <div className="files">
          <h4>Archivos generados</h4>
          <ul>
            {res.files.map((f) => (
              <li key={f.name}>
                {/\.(md|markdown)$/i.test(f.name) ? (
                  <>
                    <strong>{f.name.replace(/\.(md|markdown)$/i, "")}</strong>{" "}
                    <a href={`${f.url}?format=docx`} download>Word (.docx)</a> · <a href={`${f.url}?format=pdf`} download>PDF</a> · <a href={f.url} download={f.name}>Texto (.md)</a>
                  </>
                ) : (
                  <a href={f.url} download={f.name}>{f.name}</a>
                )}{" "}
                <span className="muted small">({fmtSize(f.size)}) · disponibles por 24 horas</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {res.status === "error" && res.text && <p className="muted">Tus datos siguen en el formulario; puedes volver a intentarlo.</p>}
      {res.status === "error" && !res.text && <p className="muted">Tus datos siguen en el formulario; puedes volver a intentarlo.</p>}
    </div>
  );
}
