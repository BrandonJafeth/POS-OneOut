-- Fase 3: apartados y crédito (DISENO-FASE3.md). Solo agrega columnas, tablas, índices y triggers:
-- no borra nada (los datos del cliente ya existen).

-- Líneas del apartado: todo lo que la venta de liquidación necesita, congelado al apartar (el
-- precio del apartado se respeta aunque el catálogo cambie).
ALTER TABLE cuenta_lineas ADD COLUMN codigo TEXT;
ALTER TABLE cuenta_lineas ADD COLUMN departamento_id TEXT REFERENCES departamentos(id);
ALTER TABLE cuenta_lineas ADD COLUMN descuento INTEGER NOT NULL DEFAULT 0;           -- colones, de la línea
ALTER TABLE cuenta_lineas ADD COLUMN descuento_catalogo INTEGER NOT NULL DEFAULT 0;  -- colones (parte del producto)
ALTER TABLE cuenta_lineas ADD COLUMN descuento_catalogo_pct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuenta_lineas ADD COLUMN tasa_iva REAL NOT NULL DEFAULT 0;
ALTER TABLE cuenta_lineas ADD COLUMN exento INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cuentas ADD COLUMN numero TEXT;                     -- A-0012 (apartado) o C-0003 (crédito)
ALTER TABLE cuentas ADD COLUMN consecutivo INTEGER;
ALTER TABLE cuentas ADD COLUMN turno_id TEXT REFERENCES caja_turnos(id);  -- turno donde se creó
ALTER TABLE cuentas ADD COLUMN fecha_limite TEXT;               -- AAAA-MM-DD
ALTER TABLE cuentas ADD COLUMN subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN descuento INTEGER NOT NULL DEFAULT 0;      -- al total
ALTER TABLE cuentas ADD COLUMN redondeo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN descuento_autorizado_por TEXT REFERENCES usuarios(id);
ALTER TABLE cuentas ADD COLUMN requiere_factura INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN venta_id TEXT REFERENCES ventas(id);       -- liquidación (apartado) o la venta a crédito
ALTER TABLE cuentas ADD COLUMN espera_id TEXT;                            -- evita crear dos con doble clic
ALTER TABLE cuentas ADD COLUMN condonado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN cancelada_en TEXT;
ALTER TABLE cuentas ADD COLUMN cancelada_por TEXT REFERENCES usuarios(id);
ALTER TABLE cuentas ADD COLUMN cancelada_motivo TEXT;
ALTER TABLE cuentas ADD COLUMN devuelto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN retenido INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN reimpresiones INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX cuentas_consecutivo ON cuentas (caja_id, consecutivo) WHERE consecutivo IS NOT NULL;
CREATE UNIQUE INDEX cuentas_espera ON cuentas (espera_id) WHERE espera_id IS NOT NULL;
CREATE INDEX cuentas_estado ON cuentas (estado, fecha_limite);
CREATE INDEX cuentas_turno ON cuentas (turno_id);

ALTER TABLE abonos ADD COLUMN recibido INTEGER;
ALTER TABLE abonos ADD COLUMN vuelto INTEGER;
ALTER TABLE abonos ADD COLUMN ultimos4 TEXT;
ALTER TABLE abonos ADD COLUMN pagador TEXT;
ALTER TABLE abonos ADD COLUMN operacion_id TEXT;               -- el mismo pago dos veces (doble clic) no crea dos abonos
ALTER TABLE abonos ADD COLUMN anulado_en TEXT;
ALTER TABLE abonos ADD COLUMN anulado_por TEXT REFERENCES usuarios(id);
ALTER TABLE abonos ADD COLUMN anulado_motivo TEXT;
ALTER TABLE abonos ADD COLUMN anulado_turno_id TEXT REFERENCES caja_turnos(id);
ALTER TABLE abonos ADD COLUMN reimpresiones INTEGER NOT NULL DEFAULT 0;
ALTER TABLE abonos ADD COLUMN gaveta_abierta_en TEXT;          -- la gaveta abre una sola vez por abono en efectivo
CREATE INDEX abonos_turno ON abonos (turno_id);
CREATE INDEX abonos_operacion ON abonos (operacion_id);

ALTER TABLE cajas ADD COLUMN cuenta_siguiente INTEGER NOT NULL DEFAULT 1;
ALTER TABLE clientes ADD COLUMN limite_credito INTEGER CHECK (limite_credito IS NULL OR limite_credito >= 0);

-- Fase 5 (utilidad bruta): costo de cada línea vendida desde ahora; las ventas viejas no lo tienen.
ALTER TABLE venta_lineas ADD COLUMN costo_unitario INTEGER CHECK (costo_unitario IS NULL OR costo_unitario >= 0);
CREATE INDEX venta_lineas_producto ON venta_lineas (producto_id);
CREATE INDEX ventas_anulada_turno ON ventas (anulada_turno_id);

-- Historial de cada cuenta, solo para agregar (como el kardex). De aquí salen las secciones del Z.
CREATE TABLE cuenta_eventos (
  id             TEXT PRIMARY KEY,
  cuenta_id      TEXT NOT NULL REFERENCES cuentas(id),
  tipo           TEXT NOT NULL CHECK (tipo IN ('creada', 'abono', 'abono_anulado', 'liquidada', 'entregada', 'cancelada', 'ajuste', 'condonacion', 'prorroga')),
  monto          INTEGER NOT NULL DEFAULT 0,
  turno_id       TEXT REFERENCES caja_turnos(id),
  abono_id       TEXT REFERENCES abonos(id),
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  autorizado_por TEXT REFERENCES usuarios(id),
  motivo         TEXT,
  fecha          TEXT NOT NULL
);
CREATE INDEX cuenta_eventos_cuenta ON cuenta_eventos (cuenta_id, fecha);
CREATE INDEX cuenta_eventos_turno ON cuenta_eventos (turno_id);
CREATE TRIGGER cuenta_eventos_sin_update BEFORE UPDATE ON cuenta_eventos
BEGIN SELECT RAISE(ABORT, 'El historial de la cuenta no se modifica'); END;
CREATE TRIGGER cuenta_eventos_sin_delete BEFORE DELETE ON cuenta_eventos
BEGIN SELECT RAISE(ABORT, 'El historial de la cuenta no se borra'); END;

-- El saldo nunca negativo; el monto de un abono no cambia después de registrado.
CREATE TRIGGER cuentas_saldo_no_negativo BEFORE UPDATE OF saldo ON cuentas WHEN NEW.saldo < 0
BEGIN SELECT RAISE(ABORT, 'El saldo no puede quedar negativo'); END;
CREATE TRIGGER abonos_monto_fijo BEFORE UPDATE OF monto, forma_pago_id, cuenta_id, turno_id ON abonos
BEGIN SELECT RAISE(ABORT, 'Un abono registrado no se modifica: anúlelo'); END;
CREATE TRIGGER abonos_sin_delete BEFORE DELETE ON abonos
BEGIN SELECT RAISE(ABORT, 'Un abono no se borra: anúlelo'); END;
