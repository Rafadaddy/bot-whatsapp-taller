@echo off
title Bot de WhatsApp - Taller Base44
color 0A

echo =====================================================================
echo           INICIANDO BOT DE WHATSAPP - TALLER BASE44
echo =====================================================================
echo.

:: Verificar si Node.js esta instalado
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js no esta instalado o no se encuentra en el PATH.
    echo Por favor instala Node.js desde https://nodejs.org
    echo.
    pause
    exit /b
)

:: Moverse a la carpeta del script
cd /d "%~dp0"

:: Verificar si node_modules existe
if not exist "node_modules\" (
    echo [INFO] Primera ejecucion detectada. Instalando librerias necesarias...
    echo Esto solo tardara un minuto...
    call npm install
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR] Ocurrio un error al instalar las dependencias.
        pause
        exit /b
    )
    echo.
)

:: Ejecutar el bot
echo [OK] Iniciando servicio del Bot...
echo Para detener el bot, simplemente CIERRA esta ventana con la X o presiona Ctrl + C.
echo.
node index.js

if %errorlevel% neq 0 (
    echo.
    echo [AVISO] El bot se ha detenido.
    pause
)
