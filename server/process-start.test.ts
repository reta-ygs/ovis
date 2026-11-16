import { describe, expect, it, spyOn } from "bun:test";
import { processStartedAt, processStartedAtAsync, processStartLowerBound, processStartUpperBound, processStartUpperBoundAsync } from "./process-start.ts";

describe("process start read without holding the event loop", () => {
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("reads the same identity the synchronous read gives, with no child process", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    // a ps here, even an awaited one, is what #1404 removed: the kernel answers on both platforms
    const spawn = spyOn(Bun, "spawn");
    const blocking = spyOn(Bun, "spawnSync");
    try {
      expect(await processStartedAtAsync(child.pid)).toBe(processStartedAt(child.pid));
      expect(await processStartedAtAsync(2147483647)).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
      expect(blocking).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      blocking.mockRestore();
      child.kill();
    }
  });
});

describe("process start time", () => {
  it("tells when a running process started, to the second", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const started = processStartedAt(child.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - Date.now())).toBeLessThan(2500);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("bounds a new Linux process closely enough to identify its first thread", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const upper = processStartUpperBound(child.pid);
      expect(upper).not.toBeNull();
      expect(upper!).toBeGreaterThanOrEqual(before);
      expect(upper!).toBeLessThanOrEqual(Date.now() + 25);
      expect(processStartUpperBound(2147483647)).toBeNull();
      // the async form a send's process check awaits is the same bound from above, never the one from below
      const awaited = await processStartUpperBoundAsync(child.pid);
      expect(awaited).not.toBeNull();
      expect(awaited!).toBeGreaterThanOrEqual(before);
      expect(awaited!).toBeLessThanOrEqual(Date.now() + 25);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("bounds a process's start from below, closely enough to take in a thread made as it starts", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const lower = processStartLowerBound(child.pid);
      expect(lower).not.toBeNull();
      // never after the process started (it started by the time spawn returned) ...
      expect(lower!).toBeLessThanOrEqual(spawned);
      // ... and close: on Linux within btime's whole second and a tick, on macOS the kernel's own start
      expect(lower!).toBeGreaterThanOrEqual(before - (process.platform === "linux" ? 1030 : 5));
      expect(processStartLowerBound(2147483647)).toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("keeps a Linux start the same on every read: it is the process's identity", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const reads = new Set(Array.from({ length: 20 }, () => processStartedAt(child.pid)));
      expect(reads.size).toBe(1);
      expect([...reads][0]).not.toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("bounds a Linux start below both readings: btime's and the uptime's", async () => {
    // btime is whole seconds: processStartedAt may be up to a second early, the bound below it still
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const started = processStartedAt(child.pid)!;
      const lower = processStartLowerBound(child.pid)!;
      expect(lower).toBeLessThanOrEqual(started - 10);
      expect(lower).toBeLessThanOrEqual(spawned);
      expect(lower).toBeGreaterThanOrEqual(before - 1030);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("samples Date.now after slow proc reads for upper bound and before /proc/uptime for lower bound", () => {
    // Boot at 1_700_000_000_000 ms (btime = 1_700_000_000 s), process started at 10050 ticks (+500 ms -> 1_700_000_100_500 ms).
    const statLine = `123 (bun) ${["S", ...Array(18).fill("0"), "10050", "0", "0"].join(" ")}`;
    let clock = 1_700_000_101_000;
    const readProc = (path: string) => {
      if (path === "/proc/123/stat") return statLine;
      if (path === "/proc/stat") {
        // Simulate 100 ms stall reading /proc/stat before reading /proc/uptime.
        clock += 100;
        return "btime 1700000000\n";
      }
      if (path === "/proc/uptime") {
        clock += 20;
        // Kernel uptime at read time: (clock - 1_700_000_000_000) / 1000 = 101.12 s.
        return `${((clock - 1_700_000_000_000) / 1000).toFixed(2)} 0.00\n`;
      }
      throw new Error(`unexpected path: ${path}`);
    };
    const actualStart = 1_700_000_100_500;
    const upper = processStartUpperBound(123, { readProc, now: () => clock });
    expect(upper).not.toBeNull();
    expect(upper!).toBeGreaterThanOrEqual(actualStart);
    expect(upper!).toBe(actualStart + 10);

    // Lower bound captures clock immediately before /proc/uptime, so /proc/uptime latency biases it downward.
    clock = 1_700_000_102_000;
    const lower = processStartLowerBound(123, { readProc, now: () => clock });
    expect(lower).not.toBeNull();
    expect(lower!).toBeLessThanOrEqual(actualStart - 10);

    // LXCFS / missing uptime fallback also uses post-read wall clock.
    let lxcfsClock = 1_700_000_100_500;
    const fallbackUpper = processStartUpperBound(123, {
      readProc(path) {
        if (path === "/proc/123/stat") return statLine;
        if (path === "/proc/stat") { lxcfsClock += 100; return "btime 1700000000\n"; }
        if (path === "/proc/uptime") return "0.05 0.00\n";
        throw new Error(`unexpected path: ${path}`);
      },
      now: () => lxcfsClock,
    });
    expect(fallbackUpper).not.toBeNull();
    expect(fallbackUpper!).toBe(1_700_000_100_610);
    expect(fallbackUpper!).toBeGreaterThanOrEqual(actualStart);
  });
});
