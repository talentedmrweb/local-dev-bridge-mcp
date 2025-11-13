#!/bin/bash

# Local Dev Bridge MCP - Quick Setup Script

echo "🚀 Local Dev Bridge MCP - Quick Setup"
echo "====================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16 or higher."
    exit 1
fi

echo "✅ Node.js found: $(node --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Get the current directory
CURRENT_DIR=$(pwd)

# Determine the OS
OS="unknown"
CONFIG_PATH=""

if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macOS"
    CONFIG_PATH="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    OS="Windows"
    CONFIG_PATH="$APPDATA/Claude/claude_desktop_config.json"
else
    OS="Linux"
    CONFIG_PATH="$HOME/.config/Claude/claude_desktop_config.json"
fi

echo ""
echo "🖥️  Detected OS: $OS"
echo "📁 Config path: $CONFIG_PATH"
echo ""

# Create config directory if it doesn't exist
CONFIG_DIR=$(dirname "$CONFIG_PATH")
if [ ! -d "$CONFIG_DIR" ]; then
    echo "📁 Creating Claude config directory..."
    mkdir -p "$CONFIG_DIR"
fi

# Generate the configuration snippet
echo "📝 Configuration to add to Claude Desktop:"
echo ""
echo "{"
echo "  \"mcpServers\": {"
echo "    \"local-dev-bridge\": {"
echo "      \"command\": \"node\","
echo "      \"args\": [\"$CURRENT_DIR/index.js\"],"
echo "      \"env\": {"
echo "        \"PROJECTS_DIR\": \"$HOME/Desktop/Projects\""
echo "      }"
echo "    }"
echo "  }"
echo "}"
echo ""

# Check if config file exists
if [ -f "$CONFIG_PATH" ]; then
    echo "⚠️  Config file exists at: $CONFIG_PATH"
    echo "   Please manually add the above configuration to the file."
else
    echo "💡 Config file not found. Would you like to create it? (y/n)"
    read -r response
    if [[ "$response" == "y" || "$response" == "Y" ]]; then
        cat > "$CONFIG_PATH" << EOF
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["$CURRENT_DIR/index.js"],
      "env": {
        "PROJECTS_DIR": "$HOME/Desktop/Projects"
      }
    }
  }
}
EOF
        echo "✅ Configuration file created!"
    fi
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Make sure Claude Desktop is completely closed"
echo "2. Verify the configuration in: $CONFIG_PATH"
echo "3. Adjust PROJECTS_DIR if needed (currently set to: $HOME/Desktop/Projects)"
echo "4. Start Claude Desktop"
echo ""
echo "Happy coding! 🚀"
