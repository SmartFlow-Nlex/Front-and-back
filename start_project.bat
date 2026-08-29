@echo off
title Start SmartFlow Project
echo ===================================================
echo   Starting SmartFlow NLEX Dashboard ^& Backend
echo ===================================================
echo.

echo [1/2] Launching Backend Dev Server...
start "SmartFlow Backend" cmd /k "cd /d %~dp0Back-End && npm run dev"

echo [2/2] Launching Frontend Dev Server...
start "SmartFlow Frontend" cmd /k "cd /d %~dp0Front-End-Dashboard && npm run dev:web"

echo.
echo ===================================================
echo   Servers are launching!
echo   - Backend: http://localhost:4000
echo   - Frontend: http://localhost:3002/dashboard/map-comparison
echo ===================================================
echo.
pause
