#Requires AutoHotkey v2.0
#SingleInstance Force

; Simulador de lector de código de barras para "Prueba de hardware POS".
; Un lector USB es un teclado: escribe el código muy rápido y termina con Enter.
; SendEvent manda pulsaciones reales (con scan code), por eso event.code sale lleno.
;
; Atajos (solo funcionan con la ventana de la app activa):
;   Ctrl+Alt+1  EAN-13 del tiquete de prueba (válido)
;   Ctrl+Alt+2  ISBN-13 real (válido)
;   Ctrl+Alt+3  EAN-13 con dígito verificador malo
;   Ctrl+Alt+4  Code 128 con símbolos (- / . espacio)
;   Ctrl+Alt+5  Tecleo humano (lento) -> debe salir TECLEO
;   Ctrl+Alt+6  10 escaneos seguidos (todos válidos)
;   Ctrl+Alt+7  Escaneo con velocidad irregular (5–35 ms)
;   Ctrl+Alt+8  Distribución de teclado distinta: manda la TECLA física del "-" de EE. UU.
;   Ctrl+Alt+Esc  Salir del script

DELAY_LECTOR := 10   ; ms entre teclas (Windows redondea a ~15 ms; -1 = lo más rápido posible)
DELAY_HUMANO := 150  ; ms entre teclas al "teclear a mano"

; Espera a que suelte Ctrl y Alt del atajo. Si se escribe con Ctrl+Alt apretados,
; Windows lo toma como AltGr y se pierden o cambian caracteres (un lector real no aprieta Ctrl/Alt).
SoltarModificadores() {
    KeyWait "Ctrl"
    KeyWait "Alt"
}

Escanear(codigo, delay := DELAY_LECTOR) {
    SoltarModificadores()
    SetKeyDelay delay, 0
    ; Modo normal (no {Text}): manda teclas físicas como un lector real, así event.code
    ; sale lleno (Digit9, KeyA…) y las mayúsculas van con Shift.
    ; Por eso los códigos NO deben llevar ! + ^ # { } (son símbolos especiales de AutoHotkey).
    SendEvent codigo "{Enter}"
}

#HotIf WinActive("Prueba de hardware POS")

^!1:: Escanear("9789968000000")
^!2:: Escanear("9780306406157")
^!3:: Escanear("9780306406158")
^!4:: Escanear("ABC-123/x.5 Z")
^!5:: Escanear("7501031311309", DELAY_HUMANO)

; Dígito verificador EAN-13 (pesos 1 y 3), para armar códigos válidos.
DigitoEan(doce) {
    suma := 0
    Loop 12
        suma += SubStr(doce, A_Index, 1) * (Mod(A_Index, 2) ? 1 : 3)
    return Mod(10 - Mod(suma, 10), 10)
}

; 10 códigos distintos y TODOS válidos: si alguno sale ✗ o con largo ≠ 13, se perdió un carácter.
^!6:: {
    Loop 10 {
        doce := "97899680000" . (A_Index - 1)
        Escanear(doce . DigitoEan(doce))
        Sleep 300
    }
}

^!7:: {
    SoltarModificadores()
    for ch in StrSplit("9789968000000") {
        SendEvent ch
        Sleep Random(5, 35)
    }
    SendEvent "{Enter}"
}

; sc00C = tecla a la derecha del 0. En teclado EE. UU. es "-", en Latinoamérica es "'".
; Así se ve qué pasa cuando el lector y Windows tienen distribuciones distintas.
^!8:: {
    SoltarModificadores()
    SetKeyDelay DELAY_LECTOR, 0
    SendEvent "ABC{sc00C}123{Enter}"
}

#HotIf

^!Esc:: ExitApp
