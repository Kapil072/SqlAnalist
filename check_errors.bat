@echo off
REM ------------------------------------------------------------------
REM  Checks the SQLAnalyst project for errors and saves everything to
REM  check_results.txt (in this folder). Safe to run any time: it does
REM  not change your code or your databases.
REM ------------------------------------------------------------------
cd /d "%~dp0"
set OUT=%~dp0check_results.txt

echo SQLAnalyst error check - %date% %time% > "%OUT%"

echo.>> "%OUT%"
echo ===== 1. BACKEND: Python syntax (compileall) =====>> "%OUT%"
.venv\Scripts\python -m compileall -q backend\app >> "%OUT%" 2>&1 && echo compileall OK>> "%OUT%"

echo.>> "%OUT%"
echo ===== 2. BACKEND: import app.main =====>> "%OUT%"
pushd backend
..\.venv\Scripts\python -c "import app.main; print('app.main imported OK')" >> "%OUT%" 2>&1

echo.>> "%OUT%"
echo ===== 3. BACKEND: pytest =====>> "%OUT%"
..\.venv\Scripts\python -m pytest -q -p no:cacheprovider >> "%OUT%" 2>&1
popd

echo.>> "%OUT%"
echo ===== 4. FRONTEND: TypeScript (tsc --noEmit) =====>> "%OUT%"
pushd frontend
call npx --no-install tsc --noEmit >> "%OUT%" 2>&1 && echo tsc OK>> "%OUT%"

echo.>> "%OUT%"
echo ===== 5. FRONTEND: ESLint (next lint) =====>> "%OUT%"
call npm run lint >> "%OUT%" 2>&1
popd

echo.>> "%OUT%"
echo ===== DONE =====>> "%OUT%"
echo.
echo Done. Results saved to check_results.txt
pause
