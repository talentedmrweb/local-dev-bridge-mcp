#!/bin/bash

echo "🚀 GitHub Repository Setup for local-dev-bridge-mcp"
echo "=================================================="
echo ""

# Check if already authenticated
gh auth status &>/dev/null
if [ $? -ne 0 ]; then
    echo "📋 You need to authenticate with GitHub first."
    echo "This script will guide you through the process."
    echo ""
    echo "Press Enter to authenticate with GitHub..."
    read
    
    # Authenticate with GitHub
    gh auth login
    
    if [ $? -ne 0 ]; then
        echo "❌ Authentication failed. Please try again."
        exit 1
    fi
fi

echo "✅ GitHub authentication confirmed!"
echo ""

# Check if remote already exists
git remote get-url origin &>/dev/null
if [ $? -eq 0 ]; then
    echo "⚠️  A remote 'origin' already exists."
    echo "Current remote: $(git remote get-url origin)"
    echo ""
    echo "Do you want to remove it and create a new GitHub repo? (y/n)"
    read -r response
    if [[ "$response" != "y" && "$response" != "Y" ]]; then
        echo "Exiting without changes."
        exit 0
    fi
    git remote remove origin
fi

# Create GitHub repository
echo "📦 Creating GitHub repository..."
gh repo create local-dev-bridge-mcp \
    --public \
    --source=. \
    --remote=origin \
    --description="MCP server for local development - bridges Claude Desktop with your local file system" \
    --push

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Success! Your repository has been created and pushed to GitHub!"
    echo ""
    echo "📍 Repository URL: https://github.com/$(gh api user --jq .login)/local-dev-bridge-mcp"
    echo ""
    echo "📋 Share this with your teammates:"
    echo "  git clone https://github.com/$(gh api user --jq .login)/local-dev-bridge-mcp.git"
    echo ""
    echo "They can then run ./setup.sh (Mac/Linux) or setup.bat (Windows) to install!"
else
    echo ""
    echo "❌ Failed to create repository. The repository might already exist."
    echo ""
    echo "Try manually:"
    echo "1. Go to https://github.com/new"
    echo "2. Create a repo named 'local-dev-bridge-mcp'"
    echo "3. Then run:"
    echo "   git remote add origin https://github.com/YOUR_USERNAME/local-dev-bridge-mcp.git"
    echo "   git push -u origin main"
fi
