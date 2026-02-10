#!/bin/bash
# Lambda - One-time setup script
#
# Installs dependencies, builds the CLI, and sets up Playwright.
# After running this, use `lambda start` to launch the agents.
set -e

# Check prerequisites
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required. Install with: brew install tmux"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required."; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: Claude Code is required. Install with: npm install -g @anthropic-ai/claude-code"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Install CLI dependencies and build
if [ -f "package.json" ]; then
  echo "Installing CLI dependencies..."
  npm install
  npm run build
  # Note: npm link may require sudo on some systems
  npm link
fi

# Install sample app dependencies
echo "Installing sample app dependencies..."
(cd sample && npm install)

# Install Playwright browsers
echo "Installing Playwright browsers..."
npx playwright install --with-deps chromium

echo ""
echo "Setup complete. Run 'lambda start' to launch the agents."
