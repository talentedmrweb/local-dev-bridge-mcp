# Local Dev Bridge MCP

A Model Context Protocol (MCP) server that provides Claude Desktop with direct access to your local file system for development tasks. This tool enables Claude to read, write, edit files, run commands, and search through your codebase.

## Features

- 📖 **Read files** - View contents of any file in your project
- ✏️ **Write files** - Create new files or overwrite existing ones
- 🔧 **Edit files** - Make precise edits by replacing specific text
- 📁 **Browse directories** - List contents of folders
- 💻 **Run commands** - Execute shell commands (npm, git, tests, etc.)
- 🔍 **Search files** - Search for text across your entire codebase

## Prerequisites

- Node.js 16 or higher
- npm or yarn
- Claude Desktop application

## Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/local-dev-bridge-mcp.git
cd local-dev-bridge-mcp
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Claude Desktop

1. Open Claude Desktop settings
2. Navigate to the "Developer" section
3. Find the MCP configuration file location:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

4. Edit the configuration file and add the local-dev-bridge server:

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/local-dev-bridge-mcp/index.js"],
      "env": {
        "PROJECTS_DIR": "/Users/YOUR_USERNAME/Desktop/Projects"
      }
    }
  }
}
```

**Important:** Replace the following:
- `/absolute/path/to/local-dev-bridge-mcp/index.js` with the actual path to where you cloned this repository
- `/Users/YOUR_USERNAME/Desktop/Projects` with the path to your projects directory

### Step 4: Restart Claude Desktop

After saving the configuration file, completely quit and restart Claude Desktop for the changes to take effect.

## Configuration

### Setting the Projects Directory

The MCP server uses a base directory for all file operations. By default, it uses `~/Desktop/Projects`. You can customize this by setting the `PROJECTS_DIR` environment variable in the Claude configuration:

```json
"env": {
  "PROJECTS_DIR": "/your/custom/path"
}
```

## Usage

Once installed, Claude will have access to the following tools:

### Read a File
Ask Claude to read any file in your project:
- "Read the package.json file"
- "Show me the contents of src/index.js"

### Write a File
Create new files or replace existing ones:
- "Create a new React component in src/components/Button.jsx"
- "Write a README.md file"

### Edit a File
Make specific changes to existing files:
- "Change the port number from 3000 to 8080 in server.js"
- "Update the version in package.json to 2.0.0"

### List Directory Contents
Browse your project structure:
- "What files are in the src folder?"
- "List all directories in the project"

### Run Commands
Execute shell commands:
- "Run npm install"
- "Execute the test suite"
- "Initialize a git repository"

### Search Files
Find text across your codebase:
- "Search for 'TODO' in all JavaScript files"
- "Find all occurrences of 'useState' in the project"

## Security Considerations

⚠️ **Important:** This tool provides Claude with direct access to your file system. Please note:

1. **File System Access**: Claude can read, write, and execute commands in the configured directory
2. **Scope Limitation**: Operations are limited to the `PROJECTS_DIR` path and its subdirectories
3. **Command Execution**: Be cautious when allowing command execution capabilities
4. **Sensitive Data**: Avoid using this in directories containing sensitive credentials or private keys

## Troubleshooting

### MCP Server Not Appearing in Claude

1. Ensure the path in `claude_desktop_config.json` is absolute and correct
2. Check that Node.js is installed and accessible from the command line
3. Verify the configuration JSON is valid (no syntax errors)
4. Completely quit and restart Claude Desktop (not just close the window)

### Permission Errors

- On macOS/Linux, ensure the script has execute permissions:
  ```bash
  chmod +x index.js
  ```
- Verify that Claude Desktop has permissions to access your projects directory

### Server Connection Issues

Check the Claude Desktop logs for error messages:
- **macOS**: `~/Library/Logs/Claude/`
- **Windows**: `%APPDATA%\Claude\Logs\`
- **Linux**: `~/.config/Claude/Logs/`

## Development

### Running Locally for Testing

You can test the MCP server standalone:

```bash
npm start
```

This will start the server on stdio, which you can interact with for debugging.

### Adding New Tools

To add new tools, modify the `setupToolHandlers()` method in `index.js`:

1. Add the tool definition in the `ListToolsRequestSchema` handler
2. Implement the tool logic in the `CallToolRequestSchema` handler
3. Create a corresponding method in the class

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Support

For issues and questions, please open an issue on GitHub.

---

## Quick Start for Team Members

### For macOS Users:

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/local-dev-bridge-mcp.git
cd local-dev-bridge-mcp

# 2. Install dependencies
npm install

# 3. Get the full path
pwd  # Copy this path

# 4. Edit Claude config
open ~/Library/Application\ Support/Claude/claude_desktop_config.json

# 5. Add the configuration (see Step 3 above)
# 6. Restart Claude Desktop
```

### For Windows Users:

```powershell
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/local-dev-bridge-mcp.git
cd local-dev-bridge-mcp

# 2. Install dependencies
npm install

# 3. Get the full path
pwd  # Copy this path

# 4. Edit Claude config
notepad $env:APPDATA\Claude\claude_desktop_config.json

# 5. Add the configuration (see Step 3 above)
# 6. Restart Claude Desktop
```
