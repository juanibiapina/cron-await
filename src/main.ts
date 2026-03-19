import { readFileSync } from "node:fs";
import { Cron } from "croner";

// --- Types ---

export interface Job {
  name: string;
  cron: string;
}

export interface Options {
  file?: string;
  timeout?: number;
  timezone?: string;
  expressions: string[];
  help: boolean;
}

export interface NextJob {
  name: string;
  cron: string;
  time: Date;
  ms: number;
}

// --- Constants ---

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// --- Arg parsing ---

function printUsage(): void {
  console.log(`Usage: cron-await [options] [expression...]

Block until the next cron schedule fires.

Options:
  --file <path>           Read jobs from JSON file (needs "name" and "cron" fields)
  --timeout <seconds>     Max wait time (exit 1 if exceeded)
  --timezone <tz>         Timezone for cron evaluation (e.g. Europe/Berlin)
  --help, -h              Show help

Positional arguments are cron expressions. Each uses the expression itself as
the job name in the output.

Exit codes:
  0  Cron fired, job info printed to stdout
  1  Timeout or runtime error
  2  Bad arguments or usage error`);
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    expressions: [],
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--file": {
        i++;
        if (i >= argv.length) {
          console.error("Error: --file requires a path argument");
          printUsage();
          process.exit(2);
        }
        options.file = argv[i];
        break;
      }
      case "--timeout": {
        i++;
        if (i >= argv.length) {
          console.error("Error: --timeout requires a value in seconds");
          printUsage();
          process.exit(2);
        }
        const val = Number(argv[i]);
        if (Number.isNaN(val) || val <= 0) {
          console.error(`Error: --timeout value must be a positive number, got "${argv[i]}"`);
          printUsage();
          process.exit(2);
        }
        options.timeout = val;
        break;
      }
      case "--timezone": {
        i++;
        if (i >= argv.length) {
          console.error("Error: --timezone requires a timezone argument");
          printUsage();
          process.exit(2);
        }
        options.timezone = argv[i];
        break;
      }
      default:
        if (arg.startsWith("--")) {
          console.error(`Error: unknown option "${arg}"`);
          printUsage();
          process.exit(2);
        }
        options.expressions.push(arg);
        break;
    }
    i++;
  }

  return options;
}

// --- File loading ---

export function loadJobsFromFile(path: string): Job[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read file "${path}": ${(err as Error).message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON from "${path}"`);
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("jobs" in data) ||
    !Array.isArray((data as { jobs: unknown }).jobs)
  ) {
    throw new Error(`File "${path}" must contain a "jobs" array`);
  }

  const entries = (data as { jobs: unknown[] }).jobs;
  const jobs: Job[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown>;
    if (typeof entry.name !== "string" || typeof entry.cron !== "string") {
      throw new Error(`Job at index ${i} in "${path}" must have "name" and "cron" string fields`);
    }
    jobs.push({ name: entry.name, cron: entry.cron });
  }

  return jobs;
}

// --- Job resolution ---

export function resolveJobs(options: Options): Job[] {
  const jobs: Job[] = [];

  for (const expr of options.expressions) {
    jobs.push({ name: expr, cron: expr });
  }

  if (options.file) {
    jobs.push(...loadJobsFromFile(options.file));
  }

  if (jobs.length === 0) {
    console.error("Error: no cron expressions or jobs provided");
    printUsage();
    process.exit(2);
  }

  for (const job of jobs) {
    try {
      new Cron(job.cron);
    } catch (err) {
      console.error(`Error: invalid cron expression "${job.cron}": ${(err as Error).message}`);
      process.exit(2);
    }
  }

  return jobs;
}

// --- Core logic ---

export function findNextJob(jobs: Job[], now: Date, timezone?: string): NextJob | null {
  let earliest: NextJob | null = null;

  for (const job of jobs) {
    const cronOpts = timezone ? { timezone } : undefined;
    const cron = new Cron(job.cron, cronOpts);
    const nextRun = cron.nextRun(now);
    if (!nextRun) continue;

    const ms = nextRun.getTime() - now.getTime();
    if (earliest === null || ms < earliest.ms) {
      earliest = { name: job.name, cron: job.cron, time: nextRun, ms };
    }
  }

  return earliest;
}

// --- Utilities ---

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

// --- Orchestrator ---

export async function awaitCron(
  jobs: Job[],
  options?: { timeout?: number; timezone?: string },
): Promise<NextJob> {
  const startTime = Date.now();
  const timeoutMs = options?.timeout ? options.timeout * 1000 : undefined;

  const next = findNextJob(jobs, new Date(), options?.timezone);
  if (!next) {
    throw new Error("No upcoming cron runs found for any job");
  }

  console.error(
    `Waiting for "${next.name}" at ${next.time.toISOString()} (${formatDuration(next.ms)})...`,
  );

  const remaining = next.ms;

  if (timeoutMs !== undefined) {
    const elapsed = Date.now() - startTime;
    const timeLeft = timeoutMs - elapsed;
    if (remaining > timeLeft) {
      // Will timeout before cron fires: sleep only for the timeout duration
      await sleepChunked(timeLeft);
      throw new Error("Timeout exceeded");
    }
  }

  await sleepChunked(remaining);

  return { name: next.name, cron: next.cron, time: next.time, ms: next.ms };
}

async function sleepChunked(ms: number): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMEOUT_MS);
    await sleep(chunk);
    remaining -= chunk;
  }
}

// --- Main ---

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const jobs = resolveJobs(options);

  const result = await awaitCron(jobs, {
    timeout: options.timeout,
    timezone: options.timezone,
  });

  console.log(
    JSON.stringify({ name: result.name, cron: result.cron, time: result.time.toISOString() }),
  );
}

// --- Entry point ---

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("cron-await.js") || process.argv[1].endsWith("main.ts"));

if (isMainModule) {
  // Graceful shutdown
  process.on("SIGINT", () => process.exit(1));
  process.on("SIGTERM", () => process.exit(1));

  main().catch((err: Error) => {
    if (err.message === "Timeout exceeded") {
      console.error("Error: timeout exceeded while waiting for cron");
      process.exit(1);
    }
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
