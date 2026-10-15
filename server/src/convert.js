// Convierte el Markdown que generan las skills a Word (.docx) o PDF, para que sea fácil de leer.
import { marked } from "marked";
import PDFDocument from "pdfkit";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  BorderStyle, ShadingType,
} from "docx";

const MAX_CHARS = 500_000;

// ---------- Utilidades de inline ----------

/** Aplana tokens inline a segmentos { text, bold, italics, code }. */
function inlineRuns(tokens = [], style = {}) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case "strong": out.push(...inlineRuns(t.tokens, { ...style, bold: true })); break;
      case "em": out.push(...inlineRuns(t.tokens, { ...style, italics: true })); break;
      case "del": out.push(...inlineRuns(t.tokens, { ...style })); break;
      case "codespan": out.push({ text: t.text, ...style, code: true }); break;
      case "br": out.push({ text: "\n", ...style }); break;
      case "link": {
        const inner = inlineRuns(t.tokens, style);
        out.push(...inner);
        if (t.href && !/^mailto:/.test(t.href) && inner.map((r) => r.text).join("") !== t.href) out.push({ text: ` (${t.href})`, ...style });
        break;
      }
      case "image": out.push({ text: t.text || "", ...style }); break;
      default: out.push({ text: decode(t.text ?? t.raw ?? ""), ...style });
    }
  }
  return out;
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const plain = (tokens) => inlineRuns(tokens).map((r) => r.text).join("");

// ---------- DOCX ----------

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

const toRuns = (tokens, base = {}) =>
  inlineRuns(tokens).map((r) => new TextRun({
    text: r.text, bold: r.bold || base.bold, italics: r.italics,
    font: r.code ? "Consolas" : undefined, size: base.size,
    shading: r.code ? { type: ShadingType.CLEAR, fill: "EEEEEE" } : undefined,
  }));

function docxBlocks(tokens, level = 0) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading":
        out.push(new Paragraph({ heading: HEADINGS[Math.min(t.depth, 6) - 1], children: toRuns(t.tokens), spacing: { before: 240, after: 120 } }));
        break;
      case "paragraph":
        out.push(new Paragraph({ children: toRuns(t.tokens), spacing: { after: 120 } }));
        break;
      case "text":
        out.push(new Paragraph({ children: t.tokens ? toRuns(t.tokens) : [new TextRun(decode(t.text))], spacing: { after: 60 } }));
        break;
      case "list":
        t.items.forEach((it, idx) => {
          const own = it.tokens.filter((x) => x.type !== "list");
          const nested = it.tokens.filter((x) => x.type === "list");
          const runs = own.flatMap((x) => (x.tokens ? toRuns(x.tokens) : [new TextRun(decode(x.text ?? ""))]));
          const prefix = t.ordered ? `${(Number(t.start) || 1) + idx}. ` : "";
          out.push(new Paragraph({
            children: [...(prefix ? [new TextRun(prefix)] : []), ...runs],
            bullet: t.ordered ? undefined : { level: Math.min(level, 8) },
            indent: t.ordered ? { left: 360 + level * 360 } : undefined,
            spacing: { after: 60 },
          }));
          for (const n of nested) out.push(...docxBlocks([n], level + 1));
        });
        break;
      case "code":
        out.push(...t.text.split("\n").map((ln) => new Paragraph({
          children: [new TextRun({ text: ln || " ", font: "Consolas", size: 20 })],
          shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
        })));
        break;
      case "blockquote":
        out.push(...docxBlocks(t.tokens, level).map((p) => p));
        break;
      case "hr":
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, spacing: { after: 120 } }));
        break;
      case "table": {
        const cell = (c, head) => new TableCell({
          children: [new Paragraph({ children: toRuns(c.tokens, { bold: head }) })],
          shading: head ? { type: ShadingType.CLEAR, fill: "E8E8F5" } : undefined,
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }),
            ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
          ],
        }));
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      }
      case "html":
        if (t.text.trim()) out.push(new Paragraph({ children: [new TextRun(t.text.replace(/<[^>]+>/g, ""))] }));
        break;
      default: break; // space, etc.
    }
  }
  return out;
}

export async function mdToDocx(md) {
  const tokens = marked.lexer(String(md).slice(0, MAX_CHARS));
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children: docxBlocks(tokens) }],
  });
  return Packer.toBuffer(doc);
}

// ---------- PDF ----------

export function mdToPdf(md) {
  const tokens = marked.lexer(String(md).slice(0, MAX_CHARS));
  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 60, right: 60 } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const fontFor = (r) => (r.code ? "Courier" : r.bold && r.italics ? "Helvetica-BoldOblique" : r.bold ? "Helvetica-Bold" : r.italics ? "Helvetica-Oblique" : "Helvetica");
  const safe = (s) => s.replace(/[^\u0000-ÿ–—‘’“”•…€]/g, "?");

  function writeRuns(tokens, { size = 11, indent = 0, bullet = null, gap = 6, bold = false } = {}) {
    const runs = inlineRuns(tokens).map((r) => ({ ...r, bold: r.bold || bold }));
    if (!runs.length) return;
    if (bullet) runs.unshift({ text: bullet + " " });
    const x = doc.page.margins.left + indent;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right - indent;
    runs.forEach((r, i) => {
      const o = { continued: i < runs.length - 1, width };
      doc.font(fontFor(r)).fontSize(size);
      if (i === 0) doc.text(safe(r.text), x, doc.y, o);
      else doc.text(safe(r.text), o);
    });
    doc.moveDown(gap / 12);
  }

  function blocks(list, indent = 0) {
    for (const t of list) {
      switch (t.type) {
        case "heading": {
          const sizes = [20, 16, 14, 12, 11, 11];
          doc.moveDown(0.4);
          writeRuns(t.tokens, { size: sizes[t.depth - 1], bold: true, indent, gap: 6 });
          break;
        }
        case "paragraph": writeRuns(t.tokens, { indent }); break;
        case "text": writeRuns(t.tokens || [{ type: "text", text: t.text }], { indent, gap: 3 }); break;
        case "list":
          t.items.forEach((it, idx) => {
            const own = it.tokens.filter((x) => x.type !== "list");
            const nested = it.tokens.filter((x) => x.type === "list");
            const toks = own.flatMap((x) => x.tokens || [{ type: "text", text: x.text ?? "" }]);
            writeRuns(toks, { indent: indent + 10, bullet: t.ordered ? `${(Number(t.start) || 1) + idx}.` : "•", gap: 3 });
            nested.forEach((n) => blocks([n], indent + 14));
          });
          doc.moveDown(0.2);
          break;
        case "code":
          doc.font("Courier").fontSize(9.5).text(safe(t.text), doc.page.margins.left + indent + 6, undefined, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - indent - 12 });
          doc.moveDown(0.5);
          break;
        case "blockquote": blocks(t.tokens, indent + 14); break;
        case "hr": {
          const y = doc.y + 4;
          doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor("#999999").lineWidth(0.5).stroke();
          doc.moveDown(0.8);
          break;
        }
        case "table": {
          // Tabla simple: cada fila como líneas "col1 | col2 | ..." con cabecera en negrita.
          const row = (cells, bold) => {
            const text = cells.map((c) => plain(c.tokens)).join("   |   ");
            doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(safe(text), doc.page.margins.left + indent);
          };
          row(t.header, true);
          t.rows.forEach((r) => row(r, false));
          doc.moveDown(0.5);
          break;
        }
        case "html": {
          const txt = t.text.replace(/<[^>]+>/g, "").trim();
          if (txt) doc.font("Helvetica").fontSize(11).text(safe(txt));
          break;
        }
        default: break;
      }
    }
  }

  blocks(tokens);
  doc.end();
  return done;
}
