# Rails Console MCP

An MCP server that lets Claude Code execute Ruby in your Rails console.

## Installation

```sh
npm install -g rails-console-mcp
```

Or run directly with npx:

```sh
npx rails-console-mcp
```

## Quick Start

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "rails-console": {
      "command": "rails-console-mcp",
      "env": {
        "RAILS_MCP_CONTAINER": "web"
      }
    }
  }
}
```

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

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RAILS_MCP_CONTAINER` | `web` | Docker container name |
| `RAILS_MCP_COMMAND_TIMEOUT` | `60000` | Per-command timeout (ms) |
| `RAILS_MCP_INACTIVITY_TIMEOUT` | `7200000` | Session timeout (2 hours) |
| `RAILS_MCP_MAX_OUTPUT` | `1048576` | Max output size (1MB) |

## How It Works

1. On first command, spawns `docker exec -i <container> bundle exec rails console`
2. Maintains persistent session - variables and state are preserved
3. Detects command completion via IRB/Pry prompt
4. Serializes concurrent commands with mutex
5. Auto-restarts once if session crashes
6. Closes after 2 hours of inactivity

## Security

This tool provides full Rails console access equivalent to `docker exec -it web rails console`.

**Use only in development environments.**

- Can read/write database
- Can access environment variables
- Can execute arbitrary Ruby code

## Troubleshooting

**Docker not running**

Ensure Docker daemon is running and the container exists:

```sh
docker ps | grep web
```

**Timeout errors**

Increase `RAILS_MCP_COMMAND_TIMEOUT` for slow queries:

```json
{
  "env": {
    "RAILS_MCP_COMMAND_TIMEOUT": "120000"
  }
}
```

**Session issues**

Run `reload!` to reset the session state without restarting.

**Container name**

If your Rails container isn't named `web`, set `RAILS_MCP_CONTAINER`:

```json
{
  "env": {
    "RAILS_MCP_CONTAINER": "my-app-web-1"
  }
}
```

## Development

```sh
# Install dependencies
npm install

# Run in dev mode
npm run dev

# Build
npm run build

# Run tests
npm test
```

## License

MIT
