import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/main.js";
import {
  awaitCron,
  findNextJob,
  formatDuration,
  loadJobsFromFile,
  parseArgs,
  resolveJobs,
} from "../src/main.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

// --- parseArgs ---

describe("parseArgs", () => {
  it("collects positional expressions", () => {
    const opts = parseArgs(["*/5 * * * *", "0 9 * * *"]);
    expect(opts.expressions).toEqual(["*/5 * * * *", "0 9 * * *"]);
    expect(opts.help).toBe(false);
  });

  it("parses --file", () => {
    const opts = parseArgs(["--file", "scheduler.json"]);
    expect(opts.file).toBe("scheduler.json");
  });

  it("parses --timeout", () => {
    const opts = parseArgs(["--timeout", "30"]);
    expect(opts.timeout).toBe(30);
  });

  it("parses --timezone", () => {
    const opts = parseArgs(["--timezone", "Europe/Berlin"]);
    expect(opts.timezone).toBe("Europe/Berlin");
  });

  it("parses --help", () => {
    const opts = parseArgs(["--help"]);
    expect(opts.help).toBe(true);
  });

  it("parses -h", () => {
    const opts = parseArgs(["-h"]);
    expect(opts.help).toBe(true);
  });

  it("exits 2 on unknown flag", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => parseArgs(["--unknown"])).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(2);
    mockExit.mockRestore();
  });

  it("exits 2 when --timeout has no value", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => parseArgs(["--timeout"])).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(2);
    mockExit.mockRestore();
  });

  it("exits 2 when --timeout has non-numeric value", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => parseArgs(["--timeout", "abc"])).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(2);
    mockExit.mockRestore();
  });
});

// --- loadJobsFromFile ---

describe("loadJobsFromFile", () => {
  it("reads valid JSON fixture and extracts name+cron", () => {
    const jobs = loadJobsFromFile(resolve(fixturesDir, "scheduler.json"));
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({ name: "post-market-scan-2130", cron: "30 21 * * 1-4" });
    expect(jobs[1]).toEqual({ name: "morning-evaluation", cron: "20 10 * * 2-5" });
    expect(jobs[2]).toEqual({ name: "daily-email", cron: "30 11 * * 2-5" });
  });

  it("ignores extra fields in job entries", () => {
    const jobs = loadJobsFromFile(resolve(fixturesDir, "scheduler.json"));
    for (const job of jobs) {
      expect(Object.keys(job)).toEqual(["name", "cron"]);
    }
  });

  it("throws on non-existent file", () => {
    expect(() => loadJobsFromFile("/nonexistent/file.json")).toThrow("Failed to read file");
  });

  it("throws on invalid JSON", () => {
    expect(() => loadJobsFromFile(resolve(fixturesDir, "invalid.json"))).toThrow(
      "Failed to parse JSON",
    );
  });

  it("throws when jobs array is missing", () => {
    expect(() => loadJobsFromFile(resolve(__dirname, "..", "package.json"))).toThrow(
      'must contain a "jobs" array',
    );
  });
});

// --- resolveJobs ---

describe("resolveJobs", () => {
  it("converts positional expressions to jobs", () => {
    const jobs = resolveJobs({
      expressions: ["*/5 * * * *", "0 9 * * *"],
      help: false,
    });
    expect(jobs).toEqual([
      { name: "*/5 * * * *", cron: "*/5 * * * *" },
      { name: "0 9 * * *", cron: "0 9 * * *" },
    ]);
  });

  it("merges positional expressions and file jobs", () => {
    const jobs = resolveJobs({
      expressions: ["*/5 * * * *"],
      file: resolve(fixturesDir, "scheduler.json"),
      help: false,
    });
    expect(jobs).toHaveLength(4);
    expect(jobs[0].name).toBe("*/5 * * * *");
    expect(jobs[1].name).toBe("post-market-scan-2130");
  });

  it("exits 2 on empty job list", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => resolveJobs({ expressions: [], help: false })).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(2);
    mockExit.mockRestore();
  });

  it("exits 2 on invalid cron expression", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => resolveJobs({ expressions: ["invalid"], help: false })).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(2);
    mockExit.mockRestore();
  });
});

// --- findNextJob ---

describe("findNextJob", () => {
  // Fixed point in time: Wednesday 2026-03-18 12:00:00 UTC
  const now = new Date("2026-03-18T12:00:00.000Z");

  it("returns the earliest job among multiple", () => {
    const jobs: Job[] = [
      { name: "hourly", cron: "0 * * * *" }, // next: 13:00 UTC
      { name: "every-5-min", cron: "*/5 * * * *" }, // next: 12:05 UTC
      { name: "daily-9am", cron: "0 9 * * *" }, // next: 09:00 UTC next day
    ];
    const result = findNextJob(jobs, now);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("every-5-min");
    expect(result?.time).toEqual(new Date("2026-03-18T12:05:00.000Z"));
  });

  it("returns null for empty list", () => {
    expect(findNextJob([], now)).toBeNull();
  });

  it("handles a single job", () => {
    const jobs: Job[] = [{ name: "hourly", cron: "0 * * * *" }];
    const result = findNextJob(jobs, now);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("hourly");
    expect(result?.ms).toBeGreaterThan(0);
  });

  it("respects timezone", () => {
    // At 2026-03-18T12:00:00 UTC, Berlin is CET (UTC+1) since DST starts March 29.
    // "0 15 * * *" = 15:00 Berlin time = 14:00 UTC
    const jobs: Job[] = [{ name: "berlin-3pm", cron: "0 15 * * *" }];
    const result = findNextJob(jobs, now, "Europe/Berlin");
    expect(result).not.toBeNull();
    expect(result?.time.getUTCHours()).toBe(14);
  });
});

// --- formatDuration ---

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatDuration(3 * 3600 * 1000 + 12 * 60 * 1000)).toBe("3h 12m");
  });

  it("formats hours only", () => {
    expect(formatDuration(2 * 3600 * 1000)).toBe("2h");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(5 * 60 * 1000 + 30 * 1000)).toBe("5m 30s");
  });

  it("formats minutes only", () => {
    expect(formatDuration(10 * 60 * 1000)).toBe("10m");
  });

  it("formats seconds only", () => {
    expect(formatDuration(45 * 1000)).toBe("45s");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

// --- awaitCron (fake timer integration tests) ---

describe("awaitCron", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the correct job when time advances", async () => {
    // Set fake clock to a known time: Wed 2026-03-18 12:00:00 UTC
    vi.setSystemTime(new Date("2026-03-18T12:00:00.000Z"));

    const jobs: Job[] = [{ name: "every-minute", cron: "* * * * *" }];

    const promise = awaitCron(jobs);

    // Advance 60 seconds to trigger the next minute
    await vi.advanceTimersByTimeAsync(60 * 1000);

    const result = await promise;
    expect(result.name).toBe("every-minute");
    expect(result.cron).toBe("* * * * *");
  });

  it("rejects after timeout when cron is far in the future", async () => {
    vi.setSystemTime(new Date("2026-03-18T12:00:00.000Z"));

    // This cron only fires on Jan 1
    const jobs: Job[] = [{ name: "yearly", cron: "0 0 1 1 *" }];

    const promise = awaitCron(jobs, { timeout: 5 });

    // Attach rejection handler before advancing time to avoid unhandled rejection
    const resultPromise = promise.then(
      () => {
        throw new Error("Expected rejection");
      },
      (err: Error) => err,
    );

    // Advance past the 5-second timeout
    await vi.advanceTimersByTimeAsync(6 * 1000);

    const error = await resultPromise;
    expect(error.message).toBe("Timeout exceeded");
  });
});
