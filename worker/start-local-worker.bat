@echo off
echo Starting local report worker (Kingdomland daily report)...
echo Keep this window open while you use the local fallback.
echo Once it says "kingdomland worker listening on :3003", go back to
echo the report site and paste http://localhost:3003 into the "Worker URL" field.
echo.
node server.js
pause
