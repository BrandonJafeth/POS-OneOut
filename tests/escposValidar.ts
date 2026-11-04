// Copia de src-tauri/src/escpos.rs::validar (lista blanca ESC/POS). Las pruebas pasan por aquí cada
// documento que arma la pantalla: si un cambio en lib/ emitiera un comando que Rust rechaza (o el
// pulso de la gaveta), la prueba falla igual que fallaría la impresión en la app.
export function validarEscPos(b: Uint8Array): void {
  const n = b.length;
  if (!n) throw new Error("vacío");
  const arg = (i: number) => {
    if (i >= n) throw new Error(`incompleto en ${i}`);
    return b[i];
  };
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c === 0x0a || (c >= 0x20 && c <= 0x7e) || c >= 0x80) {
      i++;
      continue;
    }
    if (c === 0x1b) {
      const cmd = arg(i + 1);
      if (cmd === 0x40) i += 2;
      else if (cmd === 0x74 || cmd === 0x64) (arg(i + 2), (i += 3));
      else if (cmd === 0x61) {
        if (![0, 1, 2, 0x30, 0x31, 0x32].includes(arg(i + 2))) throw new Error("alineación");
        i += 3;
      } else if (cmd === 0x45) {
        if (![0, 1].includes(arg(i + 2))) throw new Error("negrita");
        i += 3;
      } else throw new Error(`ESC 0x${cmd.toString(16)} no permitido en ${i}`);
      continue;
    }
    if (c === 0x1d) {
      const cmd = arg(i + 1);
      if (cmd === 0x21 || cmd === 0x68) (arg(i + 2), (i += 3));
      else if (cmd === 0x77) {
        const w = arg(i + 2);
        if (w < 1 || w > 6) throw new Error("ancho de barras");
        i += 3;
      } else if (cmd === 0x48) {
        if (![0, 1, 2, 3, 0x30, 0x31, 0x32, 0x33].includes(arg(i + 2))) throw new Error("HRI");
        i += 3;
      } else if (cmd === 0x6b) {
        const m = arg(i + 2);
        if (m <= 6) {
          let j = i + 3;
          while (arg(j) !== 0) {
            if (arg(j) < 0x20 || arg(j) > 0x7e) throw new Error("barras");
            j++;
          }
          i = j + 1;
        } else if (m >= 65 && m <= 73) {
          const largo = arg(i + 3);
          for (let j = i + 4; j < i + 4 + largo; j++) if (arg(j) < 0x20 || arg(j) > 0x7e) throw new Error("barras");
          i += 4 + largo;
        } else throw new Error("barras");
      } else if (cmd === 0x76) {
        if (arg(i + 2) !== 0x30 || ![0, 1, 2, 3, 48, 49, 50, 51].includes(arg(i + 3))) throw new Error("imagen");
        const x = arg(i + 4) + 256 * arg(i + 5);
        const y = arg(i + 6) + 256 * arg(i + 7);
        if (!x || x > 128 || !y || y > 4000 || i + 8 + x * y > n) throw new Error("imagen");
        i += 8 + x * y;
      } else if (cmd === 0x56) {
        const m = arg(i + 2);
        if ([0, 1, 48, 49].includes(m)) i += 3;
        else if (m === 65 || m === 66) (arg(i + 3), (i += 4));
        else throw new Error("corte");
      } else throw new Error(`GS 0x${cmd.toString(16)} no permitido en ${i}`);
      continue;
    }
    if (c === 0x1c) {
      if (arg(i + 1) !== 0x2e) throw new Error("FS");
      i += 2;
      continue;
    }
    throw new Error(`control 0x${c.toString(16)} no permitido en ${i}`);
  }
}
