@echo off
rem DevFlow on-demand launcher: starts DevFlow inside WSL and opens the dashboard.
rem Keep this window open while using DevFlow; closing it stops DevFlow. No scheduled task is created.
rem
rem Configuration (environment variables, set once with `setx` or in your own wrapper):
rem   DEVFLOW_WSL_PATH    REQUIRED. Path of this checkout INSIDE WSL, e.g. /home/<you>/projects/DevFlow
rem   DEVFLOW_WSL_DISTRO  Optional. WSL distribution name; the default distribution is used if unset.
title DevFlow
if "%DEVFLOW_WSL_PATH%"=="" (
  echo DEVFLOW_WSL_PATH is not set. Set it to the checkout path inside WSL, e.g. /home/you/projects/DevFlow
  pause
  exit /b 1
)
rem The distro name is quoted so a name containing spaces stays one argument.
if "%DEVFLOW_WSL_DISTRO%"=="" goto default_distro
wsl.exe -d "%DEVFLOW_WSL_DISTRO%" --cd "%DEVFLOW_WSL_PATH%" -- ./scripts/devflow-start.sh
goto done
:default_distro
wsl.exe --cd "%DEVFLOW_WSL_PATH%" -- ./scripts/devflow-start.sh
:done
if errorlevel 1 (
  echo.
  echo DevFlow did not start. See the message above.
  pause
)
