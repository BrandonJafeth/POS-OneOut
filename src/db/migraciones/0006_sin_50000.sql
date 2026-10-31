-- Migración 6: el billete de ¢50.000 ya no circula. Se quita de las listas por defecto,
-- pero solo si nadie las cambió (si el técnico las ajustó, se respeta su lista).
UPDATE config SET valor = '[20000,10000,5000,2000,1000,500,100,50,25,10,5]'
WHERE clave = 'caja_denominaciones' AND valor = '[50000,20000,10000,5000,2000,1000,500,100,50,25,10,5]';

UPDATE config SET valor = '[1000,2000,5000,10000,20000]'
WHERE clave = 'denominaciones_rapidas' AND valor = '[1000,2000,5000,10000,20000,50000]';
