import ExcelJS from "exceljs";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 120_000;

const TEXT_EXT = new Set(["txt", "md", "csv", "json", "tsv", "log"]);

const ext = (name = "") => name.split(".").pop().toLowerCase();

export class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

/**
 * Convierte un archivo subido en un bloque de contenido para Claude.
 * PDF -> bloque document (Claude lo lee nativamente). Resto -> texto.
 */
export async function fileToBlock(file) {
  const e = ext(file.originalname);
  const label = `Archivo: ${file.originalname}`;

  if (e === "pdf" || file.mimetype === "application/pdf") {
    if (file.buffer.subarray(0, 4).toString() !== "%PDF") {
      throw new UserInputError("El archivo no parece ser un PDF válido.");
    }
    return {
      block: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") },
        title: file.originalname,
      },
      chars: 0,
    };
  }

  if (e === "xlsx") {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer);
    } catch {
      throw new UserInputError("No se pudo leer el Excel. Verifica que sea un .xlsx válido.");
    }
    let out = "";
    wb.eachSheet((ws) => {
      out += `\n## Hoja: ${ws.name}\n`;
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = row.values.slice(1).map((v) => {
          if (v == null) return "";
          if (typeof v === "object") return String(v.result ?? v.text ?? v.richText?.map((r) => r.text).join("") ?? "");
          return String(v);
        });
        out += vals.join(",") + "\n";
      });
    });
    return textBlock(label, out);
  }

  if (TEXT_EXT.has(e) || file.mimetype.startsWith("text/")) {
    return textBlock(label, file.buffer.toString("utf8"));
  }

  throw new UserInputError("Formato no soportado. Usa PDF, TXT, CSV, MD o XLSX.");
}

function textBlock(label, body) {
  if (!body.trim()) throw new UserInputError("El archivo está vacío.");
  let text = body;
  let note = "";
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    note = "\n[El archivo se recortó por tamaño; solo se analizó la primera parte.]";
  }
  return {
    block: { type: "text", text: `${label}\n\n${text}${note}` },
    chars: text.length,
  };
}
