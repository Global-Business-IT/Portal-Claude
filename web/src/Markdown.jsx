import { Fragment } from "react";
import { marked } from "marked";

// Renderiza Markdown como elementos de React (sin HTML crudo: no hay riesgo de inyección).
function Inline({ tokens = [] }) {
  return tokens.map((t, i) => {
    switch (t.type) {
      case "strong": return <strong key={i}><Inline tokens={t.tokens} /></strong>;
      case "em": return <em key={i}><Inline tokens={t.tokens} /></em>;
      case "del": return <del key={i}><Inline tokens={t.tokens} /></del>;
      case "codespan": return <code key={i}>{t.text}</code>;
      case "br": return <br key={i} />;
      case "link": return /^https?:|^mailto:/.test(t.href) ? <a key={i} href={t.href} target="_blank" rel="noopener noreferrer"><Inline tokens={t.tokens} /></a> : <Fragment key={i}><Inline tokens={t.tokens} /></Fragment>;
      case "image": return <Fragment key={i}>{t.text}</Fragment>;
      default: return <Fragment key={i}>{t.tokens ? <Inline tokens={t.tokens} /> : unescape(t.text ?? t.raw ?? "")}</Fragment>;
    }
  });
}
const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function Blocks({ tokens }) {
  return tokens.map((t, i) => {
    switch (t.type) {
      case "heading": { const H = `h${Math.min(t.depth + 1, 6)}`; return <H key={i}><Inline tokens={t.tokens} /></H>; }
      case "paragraph": return <p key={i}><Inline tokens={t.tokens} /></p>;
      case "text": return <p key={i}><Inline tokens={t.tokens || [{ type: "text", text: t.text }]} /></p>;
      case "list": {
        const L = t.ordered ? "ol" : "ul";
        return <L key={i} start={t.ordered ? t.start || 1 : undefined}>{t.items.map((it, j) => <li key={j}><Blocks tokens={it.tokens.map((x) => (x.type === "text" ? { ...x, type: "text" } : x))} /></li>)}</L>;
      }
      case "code": return <pre key={i}><code>{t.text}</code></pre>;
      case "blockquote": return <blockquote key={i}><Blocks tokens={t.tokens} /></blockquote>;
      case "hr": return <hr key={i} />;
      case "table": return (
        <div className="mdtable" key={i}><table>
          <thead><tr>{t.header.map((c, j) => <th key={j}><Inline tokens={c.tokens} /></th>)}</tr></thead>
          <tbody>{t.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline tokens={c.tokens} /></td>)}</tr>)}</tbody>
        </table></div>
      );
      default: return null;
    }
  });
}

export default function Markdown({ text }) {
  return <div className="md"><Blocks tokens={marked.lexer(text || "")} /></div>;
}
