// ULID: 26 caracteres Crockford base32 = 48 bits de tiempo (ms) + 80 bits aleatorios.
// Se ordenan por fecha de creación y se pueden generar en cualquier caja sin coordinarse.
// Monotónico: dentro del mismo milisegundo, la parte aleatoria se incrementa en 1
// para que el orden alfabético siga siendo el orden de creación.

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let ultimoMs = -1;
let ultimoAzar: number[] = []; // 16 dígitos base32 (80 bits)

function azar(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

/** Suma 1 a la parte aleatoria. Si se desborda (prácticamente imposible) se vuelve a sortear. */
function incrementar(d: number[]): number[] {
  const r = [...d];
  for (let i = r.length - 1; i >= 0; i--) {
    if (r[i] < 31) {
      r[i]++;
      return r;
    }
    r[i] = 0;
  }
  return azar();
}

export function ulid(ahora = Date.now()): string {
  if (ahora === ultimoMs) ultimoAzar = incrementar(ultimoAzar);
  else {
    ultimoMs = ahora;
    ultimoAzar = azar();
  }
  let t = "";
  let ms = ahora;
  for (let i = 0; i < 10; i++) {
    t = ALFABETO[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  return t + ultimoAzar.map((n) => ALFABETO[n]).join("");
}

/** Milisegundos codificados en un ULID. */
export function ulidTiempo(id: string): number {
  let ms = 0;
  for (const c of id.slice(0, 10)) ms = ms * 32 + ALFABETO.indexOf(c);
  return ms;
}

export const ES_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
