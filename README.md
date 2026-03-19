# cron-await

Block until the next cron schedule fires.

A CLI tool that takes one or more cron expressions, computes the next matching time, sleeps until then, and prints the result as JSON to stdout. Designed for use in agent loops and automation scripts.

## Install

```bash
npm install -g @juanibiapina/cron-await
```

## Usage

```
cron-await [options] [expression...]
```

### Options

| Flag | Description |
|---|---|
| `--file <path>` | Read jobs from a JSON file (needs `name` and `cron` fields) |
| `--timeout <seconds>` | Max wait time (exit 1 if exceeded) |
| `--timezone <tz>` | Timezone for cron evaluation (e.g. `Europe/Berlin`) |
| `--help`, `-h` | Show help |

Positional arguments are cron expressions. Each uses the expression itself as the job name in the output.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Cron fired, job info printed to stdout |
| 1 | Timeout or runtime error |
| 2 | Bad arguments or usage error |

## Examples

Wait for the next minute boundary:

```bash
cron-await "* * * * *"
```

Wait for the earliest of two schedules:

```bash
cron-await "30 21 * * 1-4" "0 9 * * *"
```

Read jobs from a file:

```bash
cron-await --file scheduler.json
```

Timeout after 60 seconds:

```bash
cron-await --timeout 60 "0 0 1 1 *"
```

Evaluate in a specific timezone:

```bash
cron-await --timezone Europe/Berlin "0 9 * * *"
```

### Output

A single JSON line on stdout:

```json
{"name":"30 21 * * 1-4","cron":"30 21 * * 1-4","time":"2026-03-19T21:30:00.000Z"}
```

When using `--file`, the `name` field comes from the file:

```json
{"name":"post-market-scan","cron":"30 21 * * 1-4","time":"2026-03-19T21:30:00.000Z"}
```

Status messages go to stderr so stdout stays clean for piping.

## File format

The `--file` flag reads a JSON file with a `jobs` array. Each entry must have `name` and `cron` fields. Other fields are ignored.

```json
{
  "jobs": [
    {
      "name": "post-market-scan",
      "cron": "30 21 * * 1-4",
      "other": "ignored"
    },
    {
      "name": "morning-report",
      "cron": "0 9 * * 1-5"
    }
  ]
}
```

## Use with a coding agent

Run an agent loop that dispatches on the next job:

```bash
while true; do
  result=$(cron-await --file scheduler.json)
  job=$(echo "$result" | jq -r '.name')

  case "$job" in
    post-market-scan)
      run-post-market-scan
      ;;
    morning-report)
      run-morning-report
      ;;
  esac
done
```

## How it works

1. Parses cron expressions from arguments and/or a JSON file
2. Computes the next matching time for each expression using [croner](https://github.com/Hexagon/croner)
3. Picks the earliest match
4. Sleeps until that time (with chunked setTimeout to avoid overflow)
5. Prints the result as JSON to stdout

## License

MIT
