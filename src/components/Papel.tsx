// Vista previa del papel: dibuja lo que interpreta lib/preview.ts a partir de los bytes ESC/POS.
import { useMemo } from "react";
import { ean13Modules } from "../lib/ean13";
import type { PreviewItem } from "../lib/preview";

function Barcode({ data }: { data: string }) {
  const modules = ean13Modules(data);
  if (!modules) return <div className="pline bad">[código de barras inválido: {data}]</div>;
  // 2 puntos por módulo como en GS w 2 (8 puntos = 1 mm → 0,25 mm por módulo)
  return (
    <div>
      <svg width="47.5mm" height="10mm" viewBox="0 0 95 40" preserveAspectRatio="none">
        {Array.from(modules).map((m, i) => (m === "1" ? <rect key={i} x={i} y={0} width={1} height={40} fill="#000" /> : null))}
      </svg>
      <div className="pline center">{data}</div>
    </div>
  );
}

function Raster({ item }: { item: Extract<PreviewItem, { kind: "image" }> }) {
  const src = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = item.width;
    canvas.height = item.height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(item.width, item.height);
    const bpr = item.width / 8;
    for (let y = 0; y < item.height; y++)
      for (let x = 0; x < item.width; x++) {
        const on = (item.data[y * bpr + (x >> 3)] >> (7 - (x & 7))) & 1;
        const p = (y * item.width + x) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = on ? 0 : 255;
        img.data[p + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }, [item]);
  // 8 puntos = 1 mm, igual que el código de barras
  return (
    <div className={`pline ${item.align}`} style={{ lineHeight: 0 }}>
      <img src={src} alt="" style={{ width: `${item.width / 8}mm`, imageRendering: "pixelated" }} />
    </div>
  );
}

export default function Papel({ items }: { items: PreviewItem[] }) {
  return (
    <div className="paper">
      {items.map((it, i) => {
        if (it.kind === "event") return <div key={i} className="event">{it.text}</div>;
        if (it.kind === "image") return <Raster key={i} item={it} />;
        if (it.kind === "barcode")
          return it.type === 67 || it.type === 2 ? (
            <Barcode key={i} data={it.data} />
          ) : (
            <div key={i} className="event">Código de barras tipo {it.type}: {it.data}</div>
          );
        return (
          <div key={i} className={`pline ${it.align}`}>
            {it.spans.map((s, j) => {
              const cls = [s.bold && "b", s.dh && "dh", s.dw && "dw", s.bad && "bad"].filter(Boolean).join(" ");
              return (
                <span key={j} className={cls}>
                  {s.text}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
