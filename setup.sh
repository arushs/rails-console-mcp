#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing dependencies..."
npm install

echo "Building..."
npm run build

NODE_PATH=$(which node)
SCRIPT_PATH="$SCRIPT_DIR/dist/index.js"

echo ""
echo "✓ rails-console-mcp built successfully"
echo ""
echo "Add to Claude Code:"
echo ""
echo "  claude mcp add rails-console -s user \\"
echo "    -e RAILS_MCP_CONTAINER=your-container-name \\"
echo "    -- $NODE_PATH $SCRIPT_PATH"
echo ""
echo "Replace 'your-container-name' with your Docker container."
echo "Find it with: docker ps --format '{{.Names}}'"
echo ""
echo "Then restart Claude Code."

if [[ "$1" == "--staging" ]]; then
  echo ""
  echo "================================================================================"
  echo "STAGING (Kubectl) - for staging environment via Teleport:"
  echo "================================================================================"
  echo ""
  echo "1. Login to Teleport and find your cluster:"
  echo "     tsh login --proxy=teleport.example.com:443 teleport.example.com"
  echo "     tsh kube ls"
  echo "     tsh kube login your-staging-cluster"
  echo ""
  echo "2. Find the context name:"
  echo "     kubectl config get-contexts -o name | grep staging"
  echo ""
  echo "3. Add the MCP server:"
  echo ""
  echo "   claude mcp add rails-console-staging -s user \\"
  echo "     -e RAILS_MCP_MODE=kubectl \\"
  echo "     -e RAILS_MCP_KUBE_CONTEXT=your-kube-context \\"
  echo "     -e RAILS_MCP_KUBE_NAMESPACE=your-namespace \\"
  echo "     -e RAILS_MCP_KUBE_SELECTOR=app=your-console-app \\"
  echo "     -e RAILS_MCP_KUBE_CONTAINER=console \\"
  echo "     -- $NODE_PATH $SCRIPT_PATH"
  echo ""
  echo "Environment variables:"
  echo "  RAILS_MCP_MODE            - 'docker' (default) or 'kubectl'"
  echo "  RAILS_MCP_KUBE_CONTEXT    - Kubectl context (required for kubectl mode)"
  echo "  RAILS_MCP_KUBE_NAMESPACE  - Kubernetes namespace (default: default)"
  echo "  RAILS_MCP_KUBE_SELECTOR   - Pod selector (required for kubectl mode)"
  echo "  RAILS_MCP_KUBE_CONTAINER  - Container name (default: web)"
  echo "  RAILS_MCP_COMMAND_TIMEOUT - Command timeout in ms (default: 60000)"
fi

echo ""
