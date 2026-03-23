@echo off
echo === 繪本有聲書創作工坊 ===
echo.

echo [1/2] 啟動後端 (FastAPI)...
cd backend
start cmd /k "pip install -r requirements.txt && uvicorn main:app --reload --port 8000"
cd ..

echo [2/2] 啟動前端 (React)...
cd frontend
start cmd /k "npm install && npm run dev"
cd ..

echo.
echo 啟動完成！
echo 後端：http://localhost:8000
echo 前端：http://localhost:5173
echo.
pause
