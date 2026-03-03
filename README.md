# yaml-lint

Fast YAML validator, formatter, and linter — pure JS parser, configurable rules, auto-fix. **Zero dependencies.**

## Features

- Validate single files, directories (recursive), or globs
- Pure JS YAML parser — no `js-yaml` or any external package
- Auto-fix formatting issues (`--fix`)
- Configurable lint rules: indent size, max line length, trailing spaces, duplicate keys
- Schema validation against a simple YAML schema file
- JSON output mode for CI pipelines
- File watcher (`--watch`) for development
- Color output: red=error, yellow=warning, green=ok
- Exit codes: `0` pass, `1` errors, `2` warnings only

## Install

```bash
npm install -g yaml-lint
```

Or run without installing:

```bash
npx yaml-lint <file.yaml>
```

## Usage

```
yaml-lint [options] <file|dir> [file|dir...]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--fix` | Auto-fix formatting issues | — |
| `--format` | Only reformat/prettify, skip lint | — |
| `--indent <n>` | Required indent size | `2` |
| `--max-line-length <n>` | Warn on lines longer than n chars | `120` |
| `--no-trailing-spaces` | Error on trailing whitespace | — |
| `--require-document-start` | Require `---` at document start | — |
| `--no-duplicate-keys` | Error on duplicate keys | — |
| `--schema <file>` | Validate against schema YAML file | — |
| `--json` | Output errors as JSON | — |
| `--watch` | Watch files for changes and re-lint | — |
| `--no-color` | Disable color output | — |
| `-h, --help` | Show help | — |

## Examples

```bash
# Validate a single file
yaml-lint config.yaml

# Lint all YAML files in a directory recursively
yaml-lint src/

# Auto-fix trailing whitespace and indent issues
yaml-lint --fix --no-trailing-spaces config.yaml

# Strict mode: require document start, no duplicate keys
yaml-lint --require-document-start --no-duplicate-keys config.yaml

# Validate against a schema
yaml-lint --schema schema.yaml config.yaml

# Output as JSON for CI pipelines
yaml-lint --json config.yaml

# Watch for changes during development
yaml-lint --watch src/

# Lint with custom indent size of 4
yaml-lint --indent 4 --max-line-length 80 config.yaml
```

## Schema Validation

Create a `schema.yaml` file to validate required keys and types:

```yaml
required:
  - name
  - version
  - port
types:
  name: string
  version: string
  port: number
  enabled: boolean
properties:
  database:
    required:
      - host
    types:
      host: string
      port: number
```

Then run:

```bash
yaml-lint --schema schema.yaml config.yaml
```

## YAML Parser Support

The built-in pure JS parser handles:

- Block and flow scalars
- Block sequences (`- item`) and flow sequences (`[a, b, c]`)
- Block mappings (`key: value`) and flow mappings (`{key: value}`)
- Single and double quoted strings
- Multi-line strings (literal `|` and folded `>` block scalars)
- Anchors (`&anchor`) and aliases (`*alias`)
- Multi-document files (`---` separator)
- Type coercion: booleans, integers, floats, null, hex/octal literals
- Comments (`# comment`)
- Escape sequences in double-quoted strings

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All files passed — no errors or warnings |
| `1` | One or more errors found |
| `2` | Warnings only (no errors) |

## Lint Rules

| Rule | Flag | Severity |
|------|------|----------|
| `parse` | (always on) | error |
| `max-line-length` | `--max-line-length` | warning |
| `indent` | `--indent` | warning |
| `no-trailing-spaces` | `--no-trailing-spaces` | error |
| `require-document-start` | `--require-document-start` | warning |
| `trailing-newline` | (always on) | warning |
| `schema` | `--schema` | error |
| duplicate keys | `--no-duplicate-keys` | error |

## CI Integration

```yaml
# GitHub Actions
- name: Lint YAML
  run: npx yaml-lint --no-duplicate-keys --no-trailing-spaces .
```

```bash
# Pre-commit hook
yaml-lint --json --no-duplicate-keys $(git diff --cached --name-only | grep '\.ya\?ml$') || exit 1
```

## License

MIT
