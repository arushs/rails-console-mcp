# Rails Console MCP

An MCP server that lets Claude Code execute Ruby in your Rails console.

Supports both **local Docker** and **remote Kubernetes** (via Teleport) environments.

## Quick Start

```sh
git clone <repo>
cd rails-console-mcp
./setup.sh
```

The setup script will build the project and print configuration instructions.

## Configuration

### Local Development (Docker)

For Rails running in Docker Compose:

```sh
claude mcp add rails-console -s user \
  -e RAILS_MCP_CONTAINER=your-container-name \
  -- node /path/to/rails-console-mcp/dist/index.js
```

Find your container name with `docker ps --format '{{.Names}}'`.

### Staging/Production (Kubernetes)

For Rails running in Kubernetes via Teleport:

1. Login to Teleport:
   ```sh
   tsh login --proxy=teleport.example.com:443 teleport.example.com
   tsh kube login your-staging-cluster
   ```

2. Find the kubectl context:
   ```sh
   kubectl config get-contexts -o name | grep staging
   ```

3. Add the MCP server:
   ```sh
   claude mcp add rails-console-staging -s user \
     -e RAILS_MCP_MODE=kubectl \
     -e RAILS_MCP_KUBE_CONTEXT=your-kube-context \
     -e RAILS_MCP_KUBE_NAMESPACE=your-namespace \
     -e RAILS_MCP_KUBE_SELECTOR=app=your-console-app \
     -e RAILS_MCP_KUBE_CONTAINER=console \
     -- node /path/to/rails-console-mcp/dist/index.js
   ```

**Note**: You must stay logged into Teleport for kubectl mode to work.

## Usage

Once configured, Claude Code can use the `rails_console_exec` tool:

```ruby
# Count users
User.count

# Find a record
User.find_by(email: "test@example.com")

# Run queries
User.where(active: true).limit(10).pluck(:email)

# Check environment
Rails.env

# Reset session state
reload!
```

## Environment Variables

### Common

| Variable | Default | Description |
|----------|---------|-------------|
| `RAILS_MCP_MODE` | `docker` | `docker` or `kubectl` |
| `RAILS_MCP_COMMAND_TIMEOUT` | `60000` | Per-command timeout (ms) |
| `RAILS_MCP_INACTIVITY_TIMEOUT` | `7200000` | Session timeout (2 hours) |
| `RAILS_MCP_MAX_OUTPUT` | `1048576` | Max output size (1MB) |

### Docker Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `RAILS_MCP_CONTAINER` | `web` | Docker container name |

### Kubectl Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `RAILS_MCP_KUBE_CONTEXT` | (required) | Kubectl context name |
| `RAILS_MCP_KUBE_NAMESPACE` | `default` | Kubernetes namespace |
| `RAILS_MCP_KUBE_SELECTOR` | (required) | Pod selector (e.g., `app=my-rails-console`) |
| `RAILS_MCP_KUBE_CONTAINER` | `web` | Container name in pod |

## How It Works

1. On first command, spawns a persistent Rails console session
2. **Docker mode**: `docker exec -i <container> bundle exec rails console`
3. **Kubectl mode**: Discovers pod via selector, then `kubectl exec -i <pod> ...`
4. Maintains persistent session - variables and state are preserved
5. Detects command completion via IRB/Pry prompt (handles ANSI colors)
6. Serializes concurrent commands with mutex
7. Auto-restarts once if session crashes
8. Closes after 2 hours of inactivity

## Security

This tool provides full Rails console access.

**Use only in development/staging environments with appropriate access controls.**

- Can read/write database
- Can access environment variables
- Can execute arbitrary Ruby code

## Troubleshooting

### Docker not running

Ensure Docker daemon is running and the container exists:

```sh
docker ps | grep web
```

### Kubectl authentication expired

Re-login to Teleport:

```sh
tsh login --proxy=teleport.example.com:443 teleport.example.com
tsh kube login your-cluster
```

### Timeout errors

Increase `RAILS_MCP_COMMAND_TIMEOUT` for slow queries:

```sh
claude mcp add ... -e RAILS_MCP_COMMAND_TIMEOUT=120000 ...
```

### Session issues

Run `reload!` to reset the session state without restarting.

### Prompt detection issues

If commands timeout but the console is working, the prompt might not be detected. The server handles IRB, Pry, and custom colored prompts. Check debug logs for prompt matching issues.

## Development

```sh
npm install      # Install dependencies
npm run dev      # Run in dev mode
npm run build    # Build
npm test         # Run tests
```

## License

MIT
