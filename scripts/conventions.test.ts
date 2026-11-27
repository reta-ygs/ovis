import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import { browserScriptFiles, demoLaunchCounts, demoLaunches, directContextCounts, directContexts } from "./direct-contexts.ts";
import { fixedSleepCounts, fixedSleeps, markedWaitCounts, markedWaits, sleepFiles, turnWaitCounts, turnWaitFiles, turnWaits } from "./fixed-sleeps.ts";
import { fail, files, lineOf, read, repo, stripComments } from "./source-scan.ts";

const SOURCES = [...files("{src,server,shared,scripts,site,telemetry,integrations,tui}/**/*.{ts,tsx,mjs,js}"), "vite.config.ts"];

// A declaration never runs on into the next `import`: one that no semicolon ends would otherwise take the import
// after it for its own `from`, and that import's specifier would go unread.
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:(?!\bimport\b)[^;])*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

const specifiersIn = (code: string): { specifier: string; line: number }[] =>
  [...code.matchAll(SPECIFIER)].map((match) => {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    return { specifier, line: lineOf(code, match.index + match[0].lastIndexOf(specifier)) };
  });

const specifiers = (file: string): { specifier: string; at: string }[] =>
  specifiersIn(stripComments(read(file))).map(({ specifier, line }) => ({ specifier, at: `${file}:${line}: ${specifier}` }));

describe("imports", () => {
  it("name relative modules with their extension and never use the @shared alias", () => {
    const offenders = SOURCES.flatMap((file) => specifiers(file)
      .filter(({ specifier }) => specifier.startsWith("@shared/") || (specifier.startsWith(".") && !/\.(?:ts|tsx|mjs|js|css|json|md|svg|png|woff2|html|txt|wasm|sh)(?:\?[\w&=-]*)?$/.test(specifier)))
      .map(({ at }) => at));
    fail(offenders, "Imports carry explicit .ts/.tsx extensions and relative paths (AGENTS.md, Code conventions): write \"./x.ts\" or \"../shared/x.ts\", never \"./x\" or \"@shared/x\".");
  });

  it("finds the specifiers and the line each is on", () => {
    expect(specifiersIn("import { a } from \"./a.ts\";\nimport type {\n  B,\n} from '../b';\nimport \"./side.css\";\nconst c = await import(\"./c.tsx\");\nexport * from \"./d.ts\";"))
      .toEqual([{ specifier: "./a.ts", line: 1 }, { specifier: "../b", line: 4 }, { specifier: "./side.css", line: 5 }, { specifier: "./c.tsx", line: 6 }, { specifier: "./d.ts", line: 7 }]);
  });
});

describe("the frontend build", () => {
  const BUILD_SCRIPTS = ["vite.config.ts", "scripts/compressed-assets.ts", "scripts/service-worker-build.ts", "scripts/theme-bootstrap-build.ts", "scripts/shell-build.ts", "scripts/build-cache.ts"];

  it("imports nothing from server/ or relay/", () => {
    const offenders = BUILD_SCRIPTS.flatMap((file) => specifiers(file).filter(({ specifier }) => /(?:^|\/)(?:server|relay)\//.test(specifier)).map(({ at }) => at));
    fail(offenders, "The frontend build scripts import nothing from server/ or relay/ (they would load the server's environment): put what both need in shared/ (shared/web-policy.ts) and import it from there.");
  });
});

describe("what the browser loads", () => {
  // src/ and site/ are bundled for the browser, and shared/ is loaded there and by the server both.
  // An import that leads out of them (server/, relay/, scripts/, app/ …) puts code written for Bun
  // or Node into that bundle, where the environment it reads is not there.
  const MAY_IMPORT: Readonly<Record<string, readonly string[]>> = { src: ["shared"], shared: [] };
  const leadsTo = (file: string, specifier: string): string => posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\/.*$/, "");
  const crossings = Object.keys(MAY_IMPORT).flatMap((own) =>
    files(`${own}/**/*.{ts,tsx,mjs,js}`).filter((file) => !/\.test\./.test(file)).flatMap((file) =>
      specifiers(file).filter(({ specifier }) => specifier.startsWith(".")).map(({ specifier, at }) => ({ own, to: leadsTo(file, specifier), at })))
      .filter(({ to }) => to !== own));

  it("imports only from its own directory and the ones it may", () => {
    fail(crossings.filter(({ own, to }) => !MAY_IMPORT[own]?.includes(to)).map(({ at }) => at),
      "Code the browser loads imports only from the browser's side: src/ from src/ and shared/, site/ from site/, src/ and shared/, and shared/ from shared/ alone, since the server loads it too. Move what both sides need into shared/ (as shared/web-policy.ts and shared/markdown.ts were) and import it from there; a type that describes the wire goes in shared/protocol.ts.");
  });

  it("lists no import that nothing makes any more", () => {
    const made = new Set(crossings.map(({ own, to }) => `${own}/ from ${to}/`));
    fail(Object.entries(MAY_IMPORT).flatMap(([own, others]) => others.map((to) => `${own}/ from ${to}/`)).filter((allowed) => !made.has(allowed)),
      "MAY_IMPORT in scripts/conventions.test.ts allows these imports, and no code makes them any more: take them out.");
  });

  it("knows the directory an import leads to", () => {
    expect(leadsTo("src/lib/api.ts", "../../shared/protocol.ts")).toBe("shared");
    expect(leadsTo("src/lib/api.ts", "../../server/http.ts")).toBe("server");
    expect(leadsTo("src/server/list.ts", "./server/row.ts")).toBe("src");
    expect(leadsTo("site/demo/transport.ts", "../../src/lib/phone.ts")).toBe("src");
    expect(leadsTo("shared/web-policy.ts", "../package.json")).toBe("package.json");
  });
});

const gitIn = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function ratchetBase(env: Record<string, string | undefined> = process.env, cwd: string = repo): string | null {
  const named = env["RATCHET_BASE"];
  if (named) {
    if (gitIn(cwd, "cat-file", "-e", `${named}^{commit}`).status !== 0) throw new Error(`RATCHET_BASE ${named} is not in this checkout: fetch it first, as ci.yml's Fast checks does.`);
    return named;
  }
  const base = gitIn(cwd, "merge-base", "HEAD", "origin/main");
  if (base.status === 0) return base.stdout.trim();
  if (env["CI"]) console.log("No base for the ratchets here (no RATCHET_BASE, no origin/main): they compare with nothing.");
  return null;
}

const renamesSince = (base: string): Map<string, string> =>
  new Map(gitIn(repo, "diff", "--name-status", "-M", "--diff-filter=R", base).stdout.split("\n")
    .map((line) => line.split("\t")).filter((parts) => parts.length === 3).map(([, from, to]) => [to!, from!]));

const atBase = (base: string, file: string): string | null => {
  const shown = gitIn(repo, "show", `${base}:${file}`);
  return shown.status === 0 ? shown.stdout : null;
};

describe("the ratchets' base", () => {
  it("is the commit CI names, fails when that commit is not in the checkout, and is else where the branch left origin/main", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-ratchet-base-"));
    try {
      const git = (...args: string[]) => gitIn(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args);
      git("init", "-q", "-b", "work");
      git("commit", "-q", "--allow-empty", "-m", "base");
      const first = git("rev-parse", "HEAD").stdout.trim();
      expect(ratchetBase({}, root)).toBeNull();
      git("update-ref", "refs/remotes/origin/main", first);
      git("commit", "-q", "--allow-empty", "-m", "change");
      expect(ratchetBase({}, root)).toBe(first);
      expect(ratchetBase({ RATCHET_BASE: first }, root)).toBe(first);
      expect(() => ratchetBase({ RATCHET_BASE: `${"0".repeat(39)}1` }, root)).toThrow("is not in this checkout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Holds every file to its count in `json`, which may only shrink: never above the one at the ratchets' base, and
 * lowered when the code has fewer. `instead` says what to do in place of raising it.
 */
function countRatchet({ json, what, counts, list, print, instead, covered = sleepFiles }: {
  json: string; what: string; counts: () => Record<string, number>; list: (file: string) => string[]; print: string; instead: string; covered?: () => string[];
}): void {
  const baseline = JSON.parse(read(json)) as Record<string, number>;

  const committed = (): { counts: Record<string, number>; renames: Map<string, string> } | null => {
    const base = ratchetBase();
    const text = base === null ? null : atBase(base, json);
    return base === null || text === null ? null : { counts: JSON.parse(text) as Record<string, number>, renames: renamesSince(base) };
  };

  it(`never raises ${json} above the one at the ratchets' base`, () => {
    const at = committed();
    if (at === null) return;
    const before = at.counts;
    const was = (file: string): number => before[file] ?? before[at.renames.get(file) ?? ""] ?? 0;
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);
    fail([
      ...Object.entries(baseline).filter(([file, count]) => count > was(file)).map(([file, count]) => `${file}: ${count}, the base has ${was(file)}`),
      ...total(baseline) > total(before) ? [`total: ${total(baseline)}, the base has ${total(before)}`] : [],
    ], `${json} may only shrink: ${instead} A renamed file takes its entry along with the same count, which keeps the total.`);
  });

  it(`adds no ${what} and lowers the baseline when one goes`, () => {
    const now = counts();
    const grown = Object.entries(now).filter(([file, count]) => count > (baseline[file] ?? 0));
    fail(grown.flatMap(([file, count]) => [`${file}: ${count} ${what}s, baseline ${baseline[file] ?? 0}`, ...list(file).map((line) => `  ${line}`)]),
      `${instead} Never raise ${json}; when a file was renamed, move its entry to the new path with the same count.`);
    const shrunk = Object.entries(baseline).filter(([file, count]) => (now[file] ?? 0) < count);
    fail(shrunk.map(([file, count]) => `${file}: ${now[file] ?? 0} now, baseline ${count}`),
      `These ${what}s went away: lower their entries in ${json} to the counts shown (remove an entry at 0; \`${print}\` prints them all), so they cannot come back.`);
  });

  it("lists only files that exist", () => {
    fail(Object.keys(baseline).filter((file) => !existsSync(join(repo, file)) || !covered().includes(file)),
      `Remove these entries from ${json}: the files are gone or no longer covered. A renamed file keeps its entry under the new path, with the same count.`);
  });
}

const WAIT_FOR_THE_CONDITION = "Wait for the condition, not for a set time (AGENTS.md: bounded polls and deadlines, never fixed sleeps): poll in a loop bounded by a deadline (`const deadline = Date.now() + 10_000; while (!done()) { if (Date.now() > deadline) throw new Error(\"…\"); await Bun.sleep(25); }`), or race a timeout against the event (`Promise.race`).";

describe("fixed sleeps", () => {
  countRatchet({
    json: "scripts/fixed-sleeps.json", what: "fixed sleep", counts: fixedSleepCounts, list: fixedSleeps, print: "bun scripts/fixed-sleeps.ts",
    instead: `${WAIT_FOR_THE_CONDITION} A wait that must be fixed (proving that nothing arrives, a settle gap herdr needs) says so with \`// fixed wait: <why>\` on its line or the line above, and counts in scripts/fixed-waits.json instead.`,
  });

  it("tells a fixed sleep from a bounded poll", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("await Bun.sleep(300);")).toBe(1);
    expect(found("await page.waitForTimeout(500);")).toBe(1);
    expect(found("// fixed wait: nothing may arrive in this time\nawait page.waitForTimeout(500);")).toBe(0);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 1500));")).toBe(1);
    expect(found("while (!ready) await Bun.sleep(20);")).toBe(1);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 0));")).toBe(0);
    expect(found("while (!done() && Date.now() < deadline) await Bun.sleep(25);")).toBe(0);
    expect(found("for (let i = 0; i < 40 && !seen(); i++) await Bun.sleep(50);")).toBe(0);
    expect(found("const deadline = Date.now() + 5000;\nwhile (!await check()) {\n  assert.ok(Date.now() < deadline, \"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("for (;;) {\n  if (seen()) break;\n  if (Date.now() > deadline) throw new Error(\"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("await Promise.race([event, Bun.sleep(1000)]);")).toBe(0);
    expect(found("// fixed wait: nothing may arrive in this time\nawait Bun.sleep(NO_SEND_WAIT_MS);")).toBe(0);
    expect(found("async function f() {\n  while (Date.now() < deadline) {\n    const g = async () => { await Bun.sleep(5); };\n  }\n}")).toBe(1);
    expect(found("await Bun.sleep(1000); // fixed wait:")).toBe(1);
    expect(found("for (let i = 0; i < panes.length; i++) { await Bun.sleep(1000); }")).toBe(1);
    expect(found("for (let attempt = 0; attempt < MAX_TRIES && !seen(); attempt++) await Bun.sleep(50);")).toBe(0);
    expect(found("await new Promise((r) => setTimeout(() => r(), 500));")).toBe(1);
    expect(found("await new Promise(function (r) { setTimeout(r, 500); });")).toBe(1);
  });

  it("counts each call of a sleep helper, not its definition", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(10);\nawait sleep(20);")).toBe(2);
    expect(found("function delay(ms) { return Bun.sleep(ms); }\nawait delay(300);")).toBe(1);
    expect(found("const wait = (ms: number) => page.waitForTimeout(ms);\nawait wait(10);\nawait wait(20);")).toBe(2);
    expect(found("import { setTimeout as sleep } from \"node:timers/promises\";\nawait sleep(500);")).toBe(1);
    expect(found("const wait = io.wait ?? Bun.sleep;\nawait wait(5);")).toBe(1);
    expect(found("const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));\nawait tick();\nawait tick(20);")).toBe(1);
    expect(found("const wait = io.wait ?? Bun.sleep;\nwhile (Date.now() < deadline) await wait(25);")).toBe(0);
    expect(found("async function flood() {\n  await Bun.sleep(150);\n  send();\n}\nawait flood();\nawait flood();")).toBe(1);
  });
});

describe("names from before Ovis", () => {
  const CARRY_OVER: Record<string, string> = {
    "server/legacy-env.ts": "maps each old setting to its new name",
    "server/legacy-env.test.ts": "tests that mapping",
    "nix/smoke-check.ts": "tests that the packaged launcher ignores managed mode from an earlier install",
    "src/lib/legacyStorage.ts": "moves old browser storage keys",
    "src/lib/legacyStorage.test.ts": "tests that move",
    "server/auth.ts": "still accepts and clears the old cookies",
    "server/auth.test.ts": "tests the old cookies",
    "server/pty/session.ts": "keeps the token from the PTY host under either name",
    "crates/pty-sidecar/src/pty.rs": "keeps the token from the attach under either name",
    "server/pty/host.test.ts": "tests that the PTY host keeps the token from the command under either name",
    "server/remote-host.ts": "a remote bundle published before the rename reads the old name",
    "install.sh": "reads the old settings of an earlier install",
    "scripts/plugin-tui.ts": "withholds the old token name from ovis tui too, as a shell set up for an earlier install may export it",
    "scripts/plugin-tui.test.ts": "tests that ovis tui gets the old token name no more than the new one",
    "crates/ovis-tui/src/main.rs": "removes the old token name from its environment too, as plugin-tui.ts withholds it",
    "scripts/install-herdr-core.test.ts": "tests that install.sh replaces an earlier install's runtime under its old name",
    "scripts/install-ovis-command.test.ts": "tests that the ovis command reads an earlier install's state dir setting under its old name",
    "install.ps1": "reads the old settings of an earlier install",
    "app/windows/src/Setup.cs": "reads the token of an earlier install's settings, as install.ps1 does",
    "app/windows/tests/SetupTests.cs": "tests that read",
    "docs/guide.md": "tells users the old names still work",
    "shared/telemetry.ts": "pinned to the deployed telemetry Worker, so not even a comment changes",
  };
  // released notes keep the names they shipped with; telemetry/ is the deployed Worker's source
  const HISTORY = [":!CHANGELOG.md", ":!release-summaries.json", ":!changelog.d", ":!telemetry"];

  it("appear only where an older install hands them in", () => {
    const grep = spawnSync("git", ["grep", "--untracked", "-I", "-l", "-E", "HERDR_WEB_[A-Z0-9_]+|herdr_web_(token|device)|herdr-web-ui[:]|[/\"'`][.]herdr-web-ui([^a-z.-]|$)", "--", ".", ...HISTORY], { cwd: repo, encoding: "utf8" });
    if (grep.status === null || grep.status > 1) return;
    const offenders = grep.stdout.split("\n").filter((file) => file !== "" && !(file in CARRY_OVER));
    fail(offenders, "Use the Ovis names: OVIS_* for settings, ovis_token and ovis_device for cookies, ovis:* for browser storage keys, .ovis for pasted files. The old names are read only by the files in CARRY_OVER (scripts/conventions.test.ts), which carry an older install over.");
  });
});

describe("raw NUL bytes", () => {
  // A raw 0x00 in a source file still compiles, but git and review tools then show the file's
  // diff as binary, so whatever else changed in it goes unreviewed. Tracked text is read as bytes
  // (offsets are byte offsets), listed with `git ls-files -z` (a path may hold a newline).
  // Every tracked file is text except these binary formats. git's own binary flag cannot choose:
  // a text file with a NUL in it is exactly what git starts calling binary.
  const BINARY_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf", ".webm", ".mp4", ".mov", ".mp3", ".wav", ".pdf", ".zip", ".gz", ".tgz", ".jar", ".wasm", ".dmg"]);

  const isText = (path: string): boolean => {
    const name = path.split("/").at(-1)!;
    const dot = name.lastIndexOf(".");
    return dot < 0 || !BINARY_SUFFIXES.has(name.slice(dot).toLowerCase());
  };

  const nulAt = (path: string, bytes: Uint8Array): string | null => {
    const at = bytes.indexOf(0);
    return at < 0 ? null : `${JSON.stringify(path)}: raw NUL at byte ${at}`;
  };

  const scanNul = (root: string, env: Record<string, string | undefined> = process.env): { scanned: number; offenders: string[] } => {
    const listed = spawnSync("git", ["ls-files", "-z", "--cached"], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 });
    if (listed.error || listed.status !== 0) {
      return { scanned: 0, offenders: [`git ls-files -z --cached failed in ${root}: ${listed.error?.message ?? `exit ${listed.status}, ${listed.stderr.toString().trim()}`}`] };
    }
    const top = realpathSync(root) + sep;
    let scanned = 0;
    // git lists raw name bytes: a name that is not valid UTF-8 cannot be opened by its decoded name
    const names: string[] = [];
    const badNames: string[] = [];
    for (let start = 0; start < listed.stdout.length;) {
      const end = listed.stdout.indexOf(0, start);
      const raw = listed.stdout.subarray(start, end < 0 ? listed.stdout.length : end);
      start = end < 0 ? listed.stdout.length : end + 1;
      if (!raw.length) continue;
      const name = raw.toString("utf8");
      (Buffer.from(name, "utf8").equals(raw) ? names : badNames).push(name);
    }
    const offenders = [...new Set(badNames)].map((name) => `${JSON.stringify(name)}: path is not valid UTF-8, so it cannot be read`).concat([...new Set(names)].filter(isText).flatMap((path) => {
      const file = join(root, path);
      let bytes: Uint8Array;
      try {
        const entry = lstatSync(file, { throwIfNoEntry: false });
        if (!entry || entry.isSymbolicLink() || !realpathSync(file).startsWith(top)) return [];
        if (!entry.isFile()) return [`${JSON.stringify(path)}: not a regular file`];
        bytes = readFileSync(file);
      } catch (error) {
        return [`${JSON.stringify(path)}: unreadable, ${(error as Error).message}`];
      }
      scanned += 1;
      const found = nulAt(path, bytes);
      return found ? [found] : [];
    }));
    return { scanned, offenders };
  };

  it("keeps tracked text free of raw NUL bytes", () => {
    const { scanned, offenders } = scanNul(repo);
    fail(offenders, "Remove the raw NUL (0x00) bytes from these tracked text files: one makes git and review tools show the file's diff as binary, which hides the rest of the change from review. Write the escape (\"\\0\", \"\\u0000\", \"\\x00\") in source instead, and give a binary asset a binary suffix (BINARY_SUFFIXES in scripts/conventions.test.ts).");
    expect(scanned).toBeGreaterThan(1000);
  });

  /** A throwaway repository holding `tracked` in its index and `untracked` beside it; `run` gets its root and a git environment that cannot reach another repository. */
  const withRepo = (tracked: Record<string, string | Uint8Array>, untracked: Record<string, string | Uint8Array>, run: (root: string, env: Record<string, string | undefined>) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "tracked-text-"));
    const root = join(dir, "repo");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "gitconfig") });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
    };
    try {
      mkdirSync(root);
      git("init", "-q");
      for (const [path, content] of Object.entries({ ...tracked, ...untracked })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      if (Object.keys(tracked).length) git("add", "--", ...Object.keys(tracked));
      run(root, env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("tracked text reports first raw NUL byte offset", () => {
    expect(nulAt("a.ts", Buffer.from("\0a\0"))).toBe("\"a.ts\": raw NUL at byte 0");
    expect(nulAt("src/new\nline.ts", Buffer.from("const s = \"é한\";\0\0"))).toBe("\"src/new\\nline.ts\": raw NUL at byte 18");
    expect(nulAt("a.ts", Buffer.from("clean"))).toBeNull();
    // Windows forbids a newline in a file name
    if (process.platform !== "win32") withRepo({ "docs/zero.md": "\0# Title\n", "src/new\nline.ts": "const s = \"é한\";\0\n" }, {}, (root, env) => {
      expect(scanNul(root, env)).toEqual({ scanned: 2, offenders: ["\"docs/zero.md\": raw NUL at byte 0", "\"src/new\\nline.ts\": raw NUL at byte 18"] });
    });
  });

  it("reads tracked text in any directory and with any name", () => {
    withRepo({ "crates/pty-sidecar/Cargo.lock": "version = 4\n\0", "tools/new.ts": "export {};\0", "Brewfile": "\0" }, {}, (root, env) => {
      expect(scanNul(root, env)).toEqual({ scanned: 3, offenders: ["\"Brewfile\": raw NUL at byte 0", "\"crates/pty-sidecar/Cargo.lock\": raw NUL at byte 12", "\"tools/new.ts\": raw NUL at byte 10"] });
    });
  });

  it("escaped NUL source remains text", () => {
    withRepo({ "src/escaped.ts": "const a = \"\\0\";\nconst b = \"\\u0000\";\nconst c = /\\x00/;\n", "server/x.sql": "SELECT char(0);\n" }, {}, (root, env) => {
      expect(scanNul(root, env)).toEqual({ scanned: 2, offenders: [] });
    });
  });

  it("fails closed on a tracked name that is not valid UTF-8", () => {
    withRepo({}, {}, (root, env) => {
      // in the index only: macOS and Windows refuse such a name on disk, and the scan reports it before looking there
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, env, input: "a\0", encoding: "utf8" }).stdout.trim();
      const entry = Buffer.concat([Buffer.from(`100644 ${blob}\tsrc/x`), Buffer.from([0xff]), Buffer.from(".md\n")]);
      expect(spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: root, env, input: entry }).status).toBe(0);
      expect(scanNul(root, env)).toEqual({ scanned: 0, offenders: ["\"src/x\uFFFD.md\": path is not valid UTF-8, so it cannot be read"] });
    });
  });

  it.skipIf(process.platform === "win32")("NUL-delimited filenames survive spaces newlines and Unicode", () => {
    const tracked = { "src/with space.ts": "a\0", "src/two\nlines.ts": "ab\0", "src/日本 語.md": "日\0", "src/conflict.ts": "abcd\0" };
    withRepo(tracked, {}, (root, env) => {
      // an unmerged path is listed once per stage; it is still read and reported once
      const blob = spawnSync("git", ["hash-object", "-w", "--", "src/conflict.ts"], { cwd: root, env, encoding: "utf8" }).stdout.trim();
      const stages = spawnSync("git", ["update-index", "--index-info"], { cwd: root, env, input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tsrc/conflict.ts\n`).join("") });
      expect(stages.status).toBe(0);
      expect(scanNul(root, env).offenders.sort()).toEqual([
        "\"src/conflict.ts\": raw NUL at byte 4",
        "\"src/two\\nlines.ts\": raw NUL at byte 2",
        "\"src/with space.ts\": raw NUL at byte 1",
        "\"src/日本 語.md\": raw NUL at byte 3",
      ]);
    });
  });

  it("binary, untracked, deleted and linked files are not read", () => {
    const nul = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
    expect(["bun.lock", "crates/pty-sidecar/Cargo.lock", "tools/new.ts", "LICENSE", "src/README", "app/ios/App.swift", "scripts/fixtures/a.ansi", "dist/index.js"].filter((path) => !isText(path))).toEqual([]);
    expect(["src/fonts/a.woff2", "src/icon.png", "app/Icon.PNG", "ovis-site/a.webp", "ovis-site/a.jpg", "public/favicon.ico", "app/android/gradle/wrapper/gradle-wrapper.jar", "site/clip.webm"].filter(isText)).toEqual([]);
    const outside = mkdtempSync(join(tmpdir(), "tracked-text-outside-"));
    try {
      writeFileSync(join(outside, "target.ts"), "\0");
      withRepo({
        "src/fonts/inter.woff2": nul, "public/fonts/inter.woff2": nul, "app/icon.png": nul, "src/gone.ts": "\0", "src/ok.ts": "export {};\n",
      }, { "src/untracked.ts": "\0" }, (root, env) => {
        rmSync(join(root, "src/gone.ts"));
        symlinkSync(join(outside, "target.ts"), join(root, "src/link.ts"));
        expect(spawnSync("git", ["add", "--", "src/link.ts"], { cwd: root, env }).status).toBe(0);
        expect(scanNul(root, env)).toEqual({ scanned: 1, offenders: [] });
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fails closed when git or a tracked text file cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracked-text-nogit-"));
    try {
      const { offenders } = scanNul(dir, { ...process.env, GIT_DIR: join(dir, "missing"), GIT_CEILING_DIRECTORIES: dir });
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toStartWith(`git ls-files -z --cached failed in ${dir}: exit `);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    withRepo({ "src/a.ts": "a\n" }, {}, (root, env) => {
      rmSync(join(root, "src/a.ts"));
      mkdirSync(join(root, "src/a.ts"));
      expect(scanNul(root, env).offenders).toEqual(["\"src/a.ts\": not a regular file"]);
    });
  });

  // root reads any file whatever its mode, so only another user can see a read fail
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails closed on a tracked text file it may not read", () => {
    withRepo({ "src/locked.ts": "a\n" }, {}, (root, env) => {
      chmodSync(join(root, "src/locked.ts"), 0o000);
      const { offenders } = scanNul(root, env);
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toStartWith("\"src/locked.ts\": unreadable, EACCES");
    });
  });
});
