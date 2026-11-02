import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getRoutineGuide,
  quotePowerShellArgument,
} from "../server/routine-guides.mjs";
import { probeNpmGuides } from "../server/routine-probes.mjs";
import { routineDefinitions } from "../server/routine-policies.mjs";

const program = path.resolve("C:/Program Files/Node");
const cache = path.resolve("C:/Users/fixture/npm-cache");
const npm = {
  source: "installed-owner",
  executable: path.join(program, "node.exe"),
  npmCli: path.join(program, "node_modules/npm/bin/npm-cli.js"),
  version: "11.16.0",
  resolvedPath: cache,
  documentationVersionMatches: true,
  pathChecked: true,
  activity: "idle",
  capabilities: ["cache-verify", "cache-npx"],
};

test("unknown caches remain documentation-only and no global routine enables in-app cleanup", () => {
  for (const definition of routineDefinitions.filter(
    (d) => d.mode !== "in-app",
  )) {
    const guide = getRoutineGuide(definition.id, { path: cache });
    assert.equal(guide.mode, "review-only");
    assert.equal(guide.qualified, false);
    assert.deepEqual(guide.commands, []);
    assert(guide.evidence.every((url) => url.startsWith("https://")));
    assert(guide.notices.some((line) => /never executes/.test(line)));
  }
  assert.throws(() => getRoutineGuide("unknown"), /known/);
  assert.equal(
    getRoutineGuide("unreal-zen", { path: cache, qualification: npm })
      .qualified,
    false,
  );
});

test("npm verification is mutating, full clear optional, execution keys separate and commands safely quoted", () => {
  const guide = getRoutineGuide("npm-cache", {
    path: path.join(cache, "_cacache"),
    qualification: npm,
  });
  assert.equal(guide.mode, "guided");
  assert.equal(guide.commands.length, 2);
  assert.equal(guide.commands[0].mutates, true);
  assert.equal(guide.commands[1].optional, true);
  assert.match(guide.commands[0].command, /npm-cli\.js/);
  assert.match(guide.commands[0].command, /'verify'/);
  const exec = getRoutineGuide("npm-exec-cache", {
    path: path.join(cache, "_npx"),
    qualification: {
      ...npm,
      selectedKeys: ["abcdef0123456789"],
      listedKeys: ["abcdef0123456789"],
    },
  });
  assert.equal(exec.commands.length, 3);
  assert.equal(exec.commands[0].mutates, false);
  assert.equal(exec.commands[2].mutates, true);
  assert.match(exec.commands[2].command, /'abcdef0123456789'/);
  const unlisted = getRoutineGuide("npm-exec-cache", {
    path: path.join(cache, "_npx"),
    qualification: {
      ...npm,
      selectedKeys: ["abcdef0123456789"],
      listedKeys: [],
    },
  });
  assert.equal(unlisted.commands.length, 1);
  assert.equal(quotePowerShellArgument("a';&$(secret)"), "'a'';&$(secret)'");
  assert.throws(() => quotePowerShellArgument("a\nb"), /single-line/);
});

test("unsupported versions, active/unknown consumers, path mismatch and batch shims cannot qualify commands", () => {
  const target = path.join(cache, "_cacache");
  for (const patch of [
    { version: "12.0.0" },
    { version: "11.16.0-beta" },
    { activity: "active" },
    { activity: "unknown" },
    { executable: path.join(program, "npm.cmd") },
    { pathChecked: false },
    { documentationVersionMatches: false },
    { capabilities: "cache-verify" },
    { npmCli: path.join(cache, "npm-cli.js") },
  ]) {
    assert.equal(
      getRoutineGuide("npm-cache", {
        path: target,
        qualification: { ...npm, ...patch },
      }).commands.length,
      0,
    );
  }
  assert.equal(
    getRoutineGuide("npm-cache", { path: cache, qualification: npm }).qualified,
    false,
  );
});

test("vendor guides retain bounded scope, broader effects and recovery costs without generic purges", () => {
  const nvidia = getRoutineGuide("nvidia-shaders");
  assert.match(nvidia.steps.join(" "), /disable.*reboot/i);
  assert.match(nvidia.steps.join(" "), /Restore.*restart/);
  const pnpm = getRoutineGuide("pnpm-store");
  assert.match(pnpm.steps.join(" "), /metadata/);
  assert.match(pnpm.steps.join(" "), /v12\.7/);
  assert.match(
    getRoutineGuide("pip-cache").steps.join(" "),
    /parent-directory total is not/,
  );
  assert.match(
    getRoutineGuide("nuget-http-cache").steps.join(" "),
    /Global packages are excluded/,
  );
  assert.match(
    getRoutineGuide("windows-temporary").steps.join(" "),
    /Downloads, Recycle Bin and cloud/,
  );
  assert.match(
    getRoutineGuide("gradle-cache").steps.join(" "),
    /initialization scripts, credentials/,
  );
  assert.deepEqual(getRoutineGuide("unreal-ddc").commands, []);
});

test("bounded installed npm probe invokes only version/help/config, uses native Node and leaves consumer activity unknown", async () => {
  const calls = [];
  const result = await probeNpmGuides({
    nodePath: npm.executable,
    checkPath: async () => true,
    runFile: async (exe, args, options) => {
      calls.push({ exe, args, options });
      return {
        stdout: args.includes("--version")
          ? "11.16.0"
          : args.includes("--help")
            ? "npm cache verify\nnpm cache npx ls\nnpm cache npx info\nnpm cache npx rm"
            : cache,
      };
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.scopes.length, 2);
  assert(
    calls.every(
      (call) =>
        call.exe === npm.executable &&
        call.options.shell === false &&
        call.options.timeout === 4000 &&
        call.options.maxBuffer === 65536,
    ),
  );
  assert.deepEqual(
    calls.map((call) => call.args.slice(6)),
    [
      ["--version"],
      ["cache", "--help"],
      ["config", "get", "cache", "--location=user"],
    ],
  );
  assert(
    calls.every(
      (call) =>
        call.options.env.NPM_CONFIG_OFFLINE === "true" &&
        call.options.env.NPM_CONFIG_IGNORE_SCRIPTS === "true",
    ),
  );
  assert(
    result.scopes.every(
      (scope) =>
        scope.qualification.activity === "unknown" &&
        scope.guideQualified === false,
    ),
  );
  for (const scope of result.scopes)
    assert.deepEqual(getRoutineGuide(scope.routineId, scope).commands, []);
});

test("probe environment rejects all casing variants of Node injection and npm security overrides", async () => {
  const calls = [];
  const result = await probeNpmGuides({
    nodePath: npm.executable,
    checkPath: async () => true,
    inheritedEnvironment: {
      NODE_OPTIONS: "--require=evil.js",
      node_options: "--require=evil2.js",
      Node_Options: "--require=evil3.js",
      NODE_PATH: "evil",
      node_path: "evil2",
      Node_Path: "evil3",
      NODE_V8_COVERAGE: "outside",
      Node_Redirect_Warnings: "outside.log",
      npm_config_logs_dir: "outside",
      NPM_CONFIG_LOGS_DIR: "outside2",
      Npm_Config_Logs_Dir: "outside3",
      NPM_CONFIG_OFFLINE: "false",
      Npm_Config_Ignore_Scripts: "false",
      npm_config_update_notifier: "true",
      NPM_CONFIG_LOGS_MAX: "0",
      Npm_Config_Node_Options: "--require=evil.js",
      npm_config_cache: cache,
      Npm_Config_Userconfig: "fixture.npmrc",
      Path: "fixture-path",
      UNRELATED_SECRET: "must-not-propagate",
    },
    runFile: async (exe, args, options) => {
      calls.push({ args, options });
      return {
        stdout: args.includes("--version")
          ? "11.16.0"
          : args.includes("--help")
            ? "npm cache verify"
            : cache,
      };
    },
  });
  assert.equal(result.scopes.length, 2);
  for (const { args, options } of calls) {
    const keys = Object.keys(options.env);
    assert.equal(
      keys.length,
      new Set(keys.map((key) => key.toUpperCase())).size,
    );
    assert(keys.every((key) => key === key.toUpperCase()));
    assert(!keys.some((key) => key.startsWith("NODE_")));
    assert(!keys.includes("NPM_CONFIG_NODE_OPTIONS"));
    assert(!keys.includes("UNRELATED_SECRET"));
    assert.equal(options.env.NPM_CONFIG_CACHE, cache);
    assert.equal(options.env.NPM_CONFIG_USERCONFIG, "fixture.npmrc");
    assert.equal(options.env.PATH, "fixture-path");
    assert.equal(options.env.NPM_CONFIG_OFFLINE, "true");
    assert.equal(options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
    assert.equal(options.env.NPM_CONFIG_UPDATE_NOTIFIER, "false");
    assert.equal(options.env.NPM_CONFIG_LOGS_MAX, "10");
    assert.equal(options.env.NPM_CONFIG_LOGS_DIR, options.cwd);
    assert.deepEqual(args.slice(1, 6), [
      "--offline=true",
      "--ignore-scripts=true",
      "--update-notifier=false",
      `--logs-dir=${options.cwd}`,
      "--logs-max=10",
    ]);
  }
});

test("unavailable or unsupported installed tools yield notices and never attempt provisioning or mutation", async () => {
  let calls = 0;
  const absent = await probeNpmGuides({
    checkPath: async () => false,
    runFile: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(absent.scopes, []);
  const unsupported = await probeNpmGuides({
    checkPath: async () => true,
    runFile: async () => {
      calls++;
      return { stdout: "10.0.0" };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(unsupported.scopes, []);
  assert.match(unsupported.notices[0], /outside/);
});
