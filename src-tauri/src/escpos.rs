// Validación de lo que se manda a imprimir (lista blanca de ESC/POS).
//
// La pantalla arma los bytes del tiquete, el cierre o la etiqueta, pero NO se le cree: antes de
// mandarlos a una impresora, Rust los recorre comando por comando y solo deja pasar los que usa la
// app (texto, saltos, negrita, tamaño, alineación, tabla de caracteres, código de barras, logo y
// corte). Cualquier otro byte de control se rechaza. Así un trabajo de impresión nunca puede abrir
// la gaveta (ESC p, DLE DC4): la gaveta solo se abre por los caminos de gaveta.rs.
//
// Los datos del logo (GS v 0) son binarios y se saltan por su largo declarado, igual que hace la
// impresora: un 0x1B 0x70 dentro de la imagen es imagen, no un comando.

use crate::util::Res;

const ESC: u8 = 0x1b;
const GS: u8 = 0x1d;
const FS: u8 = 0x1c;
const LF: u8 = 0x0a;

/// Tamaño máximo de un trabajo (un Z con detalle completo de un día largo cabe de sobra).
pub const MAX_BYTES: usize = 2_000_000;

fn malo(pos: usize, que: &str) -> String {
    format!("El documento a imprimir trae un comando no permitido ({que}, byte {pos}). No se imprimió.")
}

/// Revisa un trabajo completo. Ok = solo trae comandos permitidos.
pub fn validar(b: &[u8]) -> Res<()> {
    if b.is_empty() {
        return Err("No hay nada que imprimir".into());
    }
    if b.len() > MAX_BYTES {
        return Err("El documento a imprimir es demasiado grande".into());
    }
    let n = b.len();
    let arg = |i: usize| -> Res<u8> { b.get(i).copied().ok_or_else(|| malo(i, "comando incompleto")) };
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        match c {
            LF => i += 1,
            0x20..=0x7e | 0x80..=0xff => i += 1,
            ESC => {
                let cmd = arg(i + 1)?;
                match cmd {
                    b'@' => i += 2,
                    b't' => {
                        arg(i + 2)?;
                        i += 3;
                    }
                    b'a' => {
                        if !matches!(arg(i + 2)?, 0..=2 | b'0'..=b'2') {
                            return Err(malo(i, "alineación"));
                        }
                        i += 3;
                    }
                    b'E' => {
                        if !matches!(arg(i + 2)?, 0 | 1) {
                            return Err(malo(i, "negrita"));
                        }
                        i += 3;
                    }
                    b'd' => {
                        arg(i + 2)?;
                        i += 3;
                    }
                    b'p' => return Err(malo(i, "abrir gaveta")),
                    _ => return Err(malo(i, &format!("ESC {cmd:#04x}"))),
                }
            }
            GS => {
                let cmd = arg(i + 1)?;
                match cmd {
                    b'!' => {
                        arg(i + 2)?;
                        i += 3;
                    }
                    b'h' => {
                        arg(i + 2)?;
                        i += 3;
                    }
                    b'w' => {
                        if !(1..=6).contains(&arg(i + 2)?) {
                            return Err(malo(i, "ancho de barras"));
                        }
                        i += 3;
                    }
                    b'H' => {
                        if !matches!(arg(i + 2)?, 0..=3 | b'0'..=b'3') {
                            return Err(malo(i, "texto del código de barras"));
                        }
                        i += 3;
                    }
                    b'k' => {
                        let m = arg(i + 2)?;
                        if m <= 6 {
                            // Formato A: datos hasta NUL.
                            let mut j = i + 3;
                            loop {
                                let d = arg(j)?;
                                if d == 0 {
                                    break;
                                }
                                if !(0x20..=0x7e).contains(&d) || j - (i + 3) > 255 {
                                    return Err(malo(j, "código de barras"));
                                }
                                j += 1;
                            }
                            i = j + 1;
                        } else if (65..=73).contains(&m) {
                            // Formato B: largo y datos.
                            let largo = arg(i + 3)? as usize;
                            for j in i + 4..i + 4 + largo {
                                if !(0x20..=0x7e).contains(&arg(j)?) {
                                    return Err(malo(j, "código de barras"));
                                }
                            }
                            i += 4 + largo;
                        } else {
                            return Err(malo(i, "código de barras"));
                        }
                    }
                    b'v' => {
                        // GS v 0 m xL xH yL yH d1…dk  (k = (xL + xH·256) · (yL + yH·256))
                        if arg(i + 2)? != b'0' || !matches!(arg(i + 3)?, 0..=3 | 48..=51) {
                            return Err(malo(i, "imagen"));
                        }
                        let x = arg(i + 4)? as usize + 256 * arg(i + 5)? as usize;
                        let y = arg(i + 6)? as usize + 256 * arg(i + 7)? as usize;
                        if x == 0 || x > 128 || y == 0 || y > 4000 {
                            return Err(malo(i, "tamaño de imagen"));
                        }
                        let fin = i + 8 + x * y;
                        if fin > n {
                            return Err(malo(i, "imagen incompleta"));
                        }
                        i = fin;
                    }
                    b'V' => match arg(i + 2)? {
                        0 | 1 | 48 | 49 => i += 3,
                        65 | 66 => {
                            arg(i + 3)?;
                            i += 4;
                        }
                        _ => return Err(malo(i, "corte")),
                    },
                    _ => return Err(malo(i, &format!("GS {cmd:#04x}"))),
                }
            }
            FS => {
                if arg(i + 1)? != b'.' {
                    return Err(malo(i, "modo de caracteres"));
                }
                i += 2;
            }
            0x10 => return Err(malo(i, "comando en tiempo real (gaveta)")),
            otro => return Err(malo(i, &format!("control {otro:#04x}"))),
        }
    }
    Ok(())
}

/// Pulso a la gaveta (ESC p 0 25 250: pin 2, 50 ms encendido). Lo arma Rust; nunca llega de la pantalla.
pub fn pulso_gaveta() -> Vec<u8> {
    vec![ESC, b'@', ESC, b'p', 0, 25, 250]
}

/// La reimpresión debe salir marcada: Rust revisa que el documento traiga la marca.
pub fn tiene_marca_copia(b: &[u8]) -> bool {
    b.windows(13).any(|w| w == b"*** COPIA ***")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiquete() -> Vec<u8> {
        let mut v = vec![ESC, b'@', FS, b'.', ESC, b't', 19, ESC, b'a', 1, ESC, b'E', 1];
        v.extend_from_slice(b"Libreria \xa2 1.500\n");
        v.extend_from_slice(&[GS, b'!', 0x11, GS, b'h', 80, GS, b'w', 2, GS, b'H', 2, GS, b'k', 67, 13]);
        v.extend_from_slice(b"9789968000000");
        v.extend_from_slice(&[GS, b'k', 2]);
        v.extend_from_slice(b"9789968000000\0");
        // Logo de 2 bytes de ancho y 2 filas con un "ESC p" adentro: es imagen, se acepta.
        v.extend_from_slice(&[GS, b'v', b'0', 0, 2, 0, 2, 0, ESC, b'p', 0, 25]);
        v.extend_from_slice(&[ESC, b'd', 4, GS, b'V', 66, 0]);
        v
    }

    #[test]
    fn acepta_lo_que_arma_la_app() {
        validar(&tiquete()).unwrap();
    }

    #[test]
    fn rechaza_gaveta_y_controles_raros() {
        for extra in [vec![ESC, b'p', 0, 25, 250], vec![0x10, 0x14, 1, 0, 1], vec![0x07], vec![ESC, b'=', 1], vec![GS, b'(', b'A'], vec![ESC]] {
            let mut v = tiquete();
            v.extend_from_slice(&extra);
            assert!(validar(&v).is_err(), "debió rechazar {extra:?}");
        }
        // Imagen que declara más datos de los que trae: no se acepta (cortaría el resto del análisis).
        assert!(validar(&[GS, b'v', b'0', 0, 10, 0, 10, 0, 1, 2, 3]).is_err());
        assert!(validar(&[]).is_err());
        assert!(validar(&pulso_gaveta()).is_err());
    }

    #[test]
    fn marca_de_copia() {
        assert!(tiene_marca_copia(b"xx*** COPIA ***yy"));
        assert!(!tiene_marca_copia(b"COPIA"));
    }
}
