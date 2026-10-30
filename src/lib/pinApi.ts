// Hash de PIN en Rust (Argon2id). Ver src-tauri/src/pin.rs.
import { invoke } from "@tauri-apps/api/core";
import type { Hasher } from "../db/usuarios";

export const hasherTauri: Hasher = {
  hash: (pin) => invoke<string>("pin_hash", { pin }),
  verificar: (pin, hash) => invoke<boolean>("pin_verificar", { pin, hash }),
};
