@echo off
rem DevFlow on-demand launcher. Starts DevFlow in WSL and opens the dashboard.
rem Keep this window open while using DevFlow; closing it stops DevFlow. No scheduled task is created.
title DevFlow
wsl.exe -d AI-Engineering --cd "/home/peter/projects/DevFlow" -- ./scripts/devflow-start.sh
if errorlevel 1 (
  echo.
  echo DevFlow did not start. See the message above.
  pause
)
