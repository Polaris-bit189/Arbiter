@echo off
rem CLI entry point (thin shim). Why and how: see README, the command-line section.
rem Runs the entry script with ELECTRON_RUN_AS_NODE=1 instead of starting the
rem full Electron app -- the app holds a single-instance lock, so going through
rem the exe from a terminal would hand argv to a running GUI and exit.
rem
rem The path below is inside app.asar on purpose -- that is where the build
rem puts the entry (see electron-builder.yml). Measured 2026-09-14: a plain
rem Node process with ELECTRON_RUN_AS_NODE=1 loads modules out of an asar
rem archive fine, including native ones (sharp resolves via app.asar.unpacked).
rem
rem This file is deliberately ASCII-only: cmd.exe reads batch files in the
rem system OEM code page, so UTF-8 comments get mis-decoded and break lines.
rem Do not add an ampersand or a percent sign to a rem line either -- they are
rem still honoured there.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
rem Tell the entry where it lives. Without these the entry has to *guess* the
rem paths, and the payload is: a packaged install silently loses the bundled
rem full 7-Zip (falls back to the RAR-less 7za.exe from 7zip-bin). Measured
rem 2026-09-15: with only ELECTRON_RUN_AS_NODE set, sevenZipEngine().path was
rem app.asar\node_modules\7zip-bin\win\x64\7za.exe and supportsRar was false;
rem with these two lines it becomes resources\engines\7zip-full\7z.exe / true.
rem The MCP launcher has set ARBITER_IS_PACKAGED all along (target.mjs) -- this
rem shim was the half that did not, so the two disagreed silently.
set "ARBITER_IS_PACKAGED=1"
set "ARBITER_RESOURCES_PATH=%~dp0resources"
set "ARBITER_APP_PATH=%~dp0resources\app.asar"
"%~dp0Arbiter.exe" "%~dp0resources\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
