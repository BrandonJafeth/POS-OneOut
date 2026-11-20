-- Código de barras CODE128 (GS k 73) con el número del apartado en su comprobante. Apagado hasta
-- confirmarlo en la impresora real (Herramientas de hardware → Probar CODE128).
ALTER TABLE impresoras ADD COLUMN code128 INTEGER NOT NULL DEFAULT 0;
