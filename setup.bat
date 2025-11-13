@echo off
REM Local Dev Bridge MCP - Quick Setup Script for Windows

echo Local Dev Bridge MCP - Quick Setup
echo =====================================
echo.

REM Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed. Please install Node.js 16 or higher.
    exit /b 1
)

echo Node.js found
node --version
echo.

REM Install dependencies
echo Installing dependencies...
call npm install
echo.

REM Get the current directory
set CURRENT_DIR=%CD%

REM Set config path
set CONFIG_PATH=%APPDATA%\Claude\claude_desktop_config.json
set CONFIG_DIR=%APPDATA%\Claude

echo Config path: %CONFIG_PATH%
echo.

REM Create config directory if it doesn't exist
if not exist "%CONFIG_DIR%" (
    echo Creating Claude config directory...
    mkdir "%CONFIG_DIR%"
)

REM Generate the configuration
echo Configuration to add to Claude Desktop:
echo.
echo {
echo   "mcpServers": {
echo     "local-dev-bridge": {
echo       "command": "node",
echo       "args": ["%CURRENT_DIR:\=/%/index.js"],
echo       "env": {
echo         "PROJECTS_DIR": "%USERPROFILE:\=/%/Desktop/Projects"
echo       }
echo     }
echo   }
echo }
echo.

REM Check if config file exists
if exist "%CONFIG_PATH%" (
    echo Warning: Config file already exists at: %CONFIG_PATH%
    echo Please manually add the above configuration to the file.
) else (
    echo Config file not found. Would you like to create it? (Y/N)
    set /p response=
    if /i "%response%"=="y" (
        (
            echo {
            echo   "mcpServers": {
            echo     "local-dev-bridge": {
            echo       "command": "node",
            echo       "args": ["%CURRENT_DIR:\=/%/index.js"],
            echo       "env": {
            echo         "PROJECTS_DIR": "%USERPROFILE:\=/%/Desktop/Projects"
            echo       }
            echo     }
            echo   }
            echo }
        ) > "%CONFIG_PATH%"
        echo Configuration file created!
    )
)

echo.
echo Setup complete!
echo.
echo Next steps:
echo 1. Make sure Claude Desktop is completely closed
echo 2. Verify the configuration in: %CONFIG_PATH%
echo 3. Adjust PROJECTS_DIR if needed
echo 4. Start Claude Desktop
echo.
echo Happy coding!

pause
