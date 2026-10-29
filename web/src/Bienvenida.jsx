// Pantalla de entrada con el botón "Iniciar sesión con Microsoft".
// Por ahora (OPEN_ACCESS=1) el botón entra directo; cuando IT registre la app en Entra ID,
// el mismo botón llevará al inicio de sesión real de Microsoft.
export default function Bienvenida({ onEnter, onToken }) {
  return (
    <div className="center">
      <div className="card login">
        <span className="logo big">G</span>
        <h1>Portal Claude</h1>
        <p className="muted">Usa las herramientas de la empresa con Claude. Inicia sesión con tu cuenta corporativa.</p>
        <button type="button" className="msbtn" onClick={onEnter}>
          <svg width="21" height="21" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          <span>Iniciar sesión con Microsoft</span>
        </button>
        <div className="alert warn">Modo de prueba: por ahora entra directo, sin pedir tu cuenta.</div>
        <button type="button" className="linkbtn" onClick={onToken}>Ingresar con token (administrador)</button>
      </div>
    </div>
  );
}
