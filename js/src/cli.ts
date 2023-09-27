#!/usr/bin/env node

import * as esbuild from "esbuild";
import chalk from "chalk";
import fs from "fs";
import os from "os";
import path, { dirname } from "path";
import util from "util";
import * as fsWalk from "@nodelib/fs.walk";
import { minimatch } from "minimatch";
import { ArgumentParser } from "argparse";
import { v4 as uuidv4 } from "uuid";
import pluralize from "pluralize";
import { login, init as initExperiment } from "./logger";
import {
  BarProgressReporter,
  SimpleProgressReporter,
  ProgressReporter,
} from "./progress";

// Re-use the module resolution logic from Jest
import nodeModulesPaths from "./jest/nodeModulesPaths";
import {
  EvaluatorDef,
  EvaluatorFile,
  Filter,
  parseFilters,
  runEvaluator,
} from "./framework";
import { configureNode } from "./node";

// This requires require
// https://stackoverflow.com/questions/50822310/how-to-import-package-json-in-typescript
const { version } = require("../package.json");

// TODO: This could be loaded from configuration
const INCLUDE = [
  "**/*.eval.ts",
  "**/*.eval.tsx",
  "**/*.eval.js",
  "**/*.eval.jsx",
];
const EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/build/**"];
const OUT_EXT = "js";

const error = chalk.bold.red;
const warning = chalk.hex("#FFA500"); // Orange color

configureNode();

interface BuildSuccess {
  type: "success";
  result: esbuild.BuildResult;
  evaluator: EvaluatorFile;
  sourceFile: string;
}

interface BuildFailure {
  type: "failure";
  error: Error;
  sourceFile: string;
}

type BuildResult = BuildSuccess | BuildFailure;
interface FileHandle {
  inFile: string;
  outFile: string;
  rebuild: () => Promise<BuildResult>;
  watch: () => void;
  destroy: () => Promise<void>;
}

function logError(e: unknown, verbose: boolean) {
  if (!verbose) {
    console.error(`${e}`);
  } else {
    console.error(e);
  }
}

function evalWithModuleContext<T>(inFile: string, evalFn: () => T): T {
  const modulePaths = [...module.paths];
  try {
    module.paths = nodeModulesPaths(path.dirname(inFile), {});
    return evalFn();
  } finally {
    module.paths = modulePaths;
  }
}

// XXX-TEST: We should add a Test to ensure that you can reference __dirname
// and __filename in your evaluators.
function evaluateBuildResults(
  inFile: string,
  buildResult: esbuild.BuildResult
) {
  if (!buildResult.outputFiles) {
    return null;
  }
  const moduleText = buildResult.outputFiles[0].text;
  return evalWithModuleContext(inFile, () => {
    globalThis._evals = {};
    const __filename = inFile;
    const __dirname = dirname(__filename);
    new Function("require", "__filename", "__dirname", moduleText)(
      require,
      __filename,
      __dirname
    );
    return { ...globalThis._evals };
  });
}

async function initLogger(name: string) {
  const logger = await initExperiment(name);
  const info = await logger.summarize({ summarizeScores: false });
  console.log(`Experiment ${logger.name} is running at ${info.experimentUrl}`);
  return logger;
}

function buildWatchPluginForEvaluator(
  inFile: string,
  opts: EvaluatorOpts
): esbuild.Plugin {
  const plugin = {
    name: "run-evalutator-on-end",
    setup(build: esbuild.PluginBuild) {
      build.onEnd(async (result) => {
        console.log(`Done building ${inFile}`);

        if (!result.outputFiles) {
          if (opts.verbose) {
            console.warn(`Failed to compile ${inFile}`);
            console.warn(result.errors);
          } else {
            console.warn(`Failed to compile ${inFile}: ${result.errors}`);
          }
          return;
        }

        const evalResult = evaluateBuildResults(inFile, result);
        if (!evalResult) {
          return;
        }

        for (const [name, evaluator] of Object.entries(evalResult)) {
          const logger = opts.noSendLogs ? null : await initLogger(name);
          const evaluatorResult = await runEvaluator(
            logger,
            evaluator,
            opts.progressReporter,
            opts.filters
          );
          reportEvaluatorResult(evaluator.name, evaluatorResult, true);
        }
      });
    },
  };

  return plugin;
}

function reportEvaluatorResult(
  evaluatorName: string | number,
  evaluatorResult: {
    results: { scores: Record<string, number>; error: unknown }[];
    summary: unknown;
  },
  verbose: boolean
) {
  const { results, summary } = evaluatorResult;
  const failingResults = results.filter(
    (r: { error: unknown }) => r.error !== undefined
  );

  if (failingResults.length > 0) {
    // TODO: We may want to support a non-strict mode (and make this the "strict" behavior), so that
    // users can still log imperfect evaluations. In the meantime, they should handle these cases inside
    // of their tasks.
    console.warn(
      warning(
        `Evaluator ${evaluatorName} failed with ${pluralize(
          "error",
          failingResults.length,
          true
        )}${
          !verbose ? " (add --verbose to see the full error)" : ""
        }. This evaluation ("${evaluatorName}") will not be fully logged.`
      )
    );
    for (const result of failingResults) {
      logError(result.error, verbose);
    }
  } else if (summary) {
    console.log(summary);
  } else {
    const scoresByName: { [name: string]: { total: number; count: number } } =
      {};
    for (const result of results) {
      for (const [name, score] of Object.entries(result.scores)) {
        const { total, count } = scoresByName[name] || { total: 0, count: 0 };
        scoresByName[name] = { total: total + score, count: count + 1 };
      }
    }

    const summary = {
      scores: Object.fromEntries(
        Object.entries(scoresByName).map(([name, { total, count }]) => [
          name,
          {
            name,
            score: total / count,
          },
        ])
      ),
    };

    console.log(summary);
  }
}

async function initFile(
  inFile: string,
  outFile: string,
  opts: EvaluatorOpts,
  args: RunArgs
): Promise<FileHandle> {
  const buildOptions = buildOpts(inFile, outFile, opts, args);
  const ctx = await esbuild.context(buildOptions);

  return {
    inFile,
    outFile,
    rebuild: async () => {
      try {
        const result = await ctx.rebuild();
        if (!result.outputFiles) {
          return {
            type: "failure",
            error: new Error("No output file generated"),
            sourceFile: inFile,
          };
        }
        const evaluator = evaluateBuildResults(inFile, result) || {};
        return { type: "success", result, evaluator, sourceFile: inFile };
      } catch (e) {
        return { type: "failure", error: e as Error, sourceFile: inFile };
      }
    },
    watch: () => {
      ctx.watch();
    },
    destroy: async () => {
      await ctx.dispose();
    },
  };
}

interface EvaluatorState {
  [evaluator: string]: {
    sourceFile: string;
    evaluator: EvaluatorDef<unknown, unknown>;
  };
}

interface EvaluatorOpts {
  verbose: boolean;
  apiKey?: string;
  orgName?: string;
  apiUrl?: string;
  noSendLogs: boolean;
  watch: boolean;
  filters: Filter[];
  progressReporter: ProgressReporter;
}

function updateEvaluators(
  evaluators: EvaluatorState,
  buildResults: BuildResult[],
  opts: EvaluatorOpts
) {
  for (const result of buildResults) {
    if (result.type === "failure") {
      if (opts.verbose) {
        console.warn(`Failed to compile ${result.sourceFile}`);
        console.warn(result.error);
      } else {
        console.warn(
          `Failed to compile ${result.sourceFile}: ${result.error.message}`
        );
      }
      continue;
    }

    for (const [name, evaluator] of Object.entries(result.evaluator)) {
      if (
        evaluators[name] &&
        (evaluators[name].sourceFile !== result.sourceFile ||
          evaluators[name].evaluator !== evaluator)
      ) {
        console.warn(
          warning(
            `Evaluator ${name} already exists (in ${evaluators[name].sourceFile} and ${result.sourceFile}). Will skip ${name} in ${result.sourceFile}.`
          )
        );
        continue;
      }
      evaluators[name] = {
        sourceFile: result.sourceFile,
        evaluator,
      };
    }
  }
}

async function runAndWatch(
  handles: Record<string, FileHandle>,
  opts: EvaluatorOpts
) {
  const count = Object.keys(handles).length;
  console.log(`Watching ${pluralize("file", count, true)}...`);

  Object.values(handles).map((handle) => handle.watch());

  ["SIGINT", "SIGTERM"].forEach((signal: string) => {
    process.on(signal, function () {
      console.log("Stopped watching.");
      for (const handle of Object.values(handles)) {
        handle.destroy();
      }
      opts.progressReporter.stop();
      process.exit(0);
    });
  });

  // Wait forever while we watch.
  await new Promise(() => {});
}

async function runOnce(
  handles: Record<string, FileHandle>,
  opts: EvaluatorOpts
) {
  const buildPromises = Object.values(handles).map((handle) =>
    handle.rebuild()
  );

  const buildResults = await Promise.all(buildPromises);

  const evaluators: EvaluatorState = {};
  updateEvaluators(evaluators, buildResults, opts);

  const resultPromises = Object.values(evaluators).map(async (evaluator) => {
    // TODO: For now, use the eval name as the project. However, we need to evolve
    // the definition of a project and create a new concept called run, so that we
    // can name the experiment/evaluation within the run the evaluator's name.
    const logger = opts.noSendLogs
      ? null
      : await initLogger(evaluator.evaluator.name);
    return await runEvaluator(
      logger,
      evaluator.evaluator,
      opts.progressReporter,
      opts.filters
    );
  });

  console.log(`Processing ${resultPromises.length} evaluators...`);
  const allEvalsResults = await Promise.all(resultPromises);
  opts.progressReporter.stop();
  console.log("");

  for (const [evaluator, idx] of Object.keys(evaluators).map((k, i) => [
    k,
    i,
  ])) {
    reportEvaluatorResult(
      evaluator,
      allEvalsResults[idx as number],
      opts.verbose
    );
  }
}

interface RunArgs {
  files: string[];
  watch: boolean;
  verbose: boolean;
  api_key?: string;
  org_name?: string;
  api_url?: string;
  filter?: string[];
  tsconfig?: string;
  no_send_logs: boolean;
  no_progress_bars: boolean;
}

function checkMatch(
  pathInput: string,
  include_patterns: string[] | null,
  exclude_patterns: string[] | null
): boolean {
  const p = path.resolve(pathInput);
  if (include_patterns !== null) {
    let include = false;
    for (const pattern of include_patterns) {
      if (minimatch(p, pattern)) {
        include = true;
        break;
      }
    }
    if (!include) {
      return false;
    }
  }

  if (exclude_patterns !== null) {
    let exclude = false;
    for (const pattern of exclude_patterns) {
      if (minimatch(p, pattern)) {
        exclude = true;
        break;
      }
    }

    return !exclude;
  }

  return true;
}

async function collectFiles(inputPath: string): Promise<string[]> {
  let pathStat = null;
  try {
    pathStat = fs.lstatSync(inputPath);
  } catch (e) {
    console.error(error(`Error reading ${inputPath}: ${e}`));
    process.exit(1);
  }

  let files: string[] = [];
  if (!pathStat.isDirectory()) {
    if (checkMatch(inputPath, INCLUDE, EXCLUDE)) {
      files.push(inputPath);
    }
  } else {
    const walked = await util.promisify(fsWalk.walk)(inputPath, {
      deepFilter: (entry) => {
        return checkMatch(entry.path, null, EXCLUDE);
      },
      entryFilter: (entry) => {
        return (
          entry.dirent.isFile() && checkMatch(entry.path, INCLUDE, EXCLUDE)
        );
      },
    });

    files = files.concat(walked.map((entry) => entry.path));
  }

  return files;
}

// Inspired by https://github.com/evanw/esbuild/issues/619
// In addition to marking node_modules external, explicitly mark
// our packages (braintrust and autoevals) external, in case they're
// installed in a relative path.
let markOurPackagesExternalPlugin = {
  name: "make-all-packages-external",
  setup(build: esbuild.PluginBuild) {
    const filter = /^(\w)/;
    build.onResolve({ filter }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

function buildOpts(
  fileName: string,
  outFile: string,
  opts: EvaluatorOpts,
  args: RunArgs
): esbuild.BuildOptions {
  const plugins = [markOurPackagesExternalPlugin];
  if (opts.watch) {
    plugins.push(buildWatchPluginForEvaluator(fileName, opts));
  }
  return {
    entryPoints: [fileName],
    bundle: true,
    outfile: outFile,
    platform: "node",
    write: false,
    // Remove the leading "v" from process.version
    target: `node${process.version.slice(1)}`,
    tsconfig: args.tsconfig,
    external: ["node_modules/*"],
    plugins: plugins,
  };
}

async function initializeHandles(args: RunArgs, opts: EvaluatorOpts) {
  const files: Record<string, boolean> = {};
  const inputPaths = args.files.length > 0 ? args.files : ["."];
  for (const inputPath of inputPaths) {
    const newFiles = await collectFiles(inputPath);
    if (newFiles.length == 0) {
      console.warn(
        warning(
          `Provided path ${inputPath} is not an eval file or a directory containing eval files, skipping...`
        )
      );
    }
    for (const file of newFiles) {
      files[path.resolve(file)] = true;
    }
  }

  if (Object.keys(files).length == 0) {
    console.warn(
      warning("No eval files were found in any of the provided paths.")
    );
    process.exit(0);
  }

  let tmpDir = path.join(os.tmpdir(), `btevals-${uuidv4().slice(0, 8)}`);
  // fs.mkdirSync(tmpDir, { recursive: true });

  const initPromises = [];
  for (const file of Object.keys(files)) {
    const outFile = path.join(
      tmpDir,
      `${path.basename(file, path.extname(file))}-${uuidv4().slice(
        0,
        8
      )}.${OUT_EXT}`
    );
    initPromises.push(initFile(file, outFile, opts, args));
  }

  const handles: Record<string, FileHandle> = {};
  const initResults = await Promise.all(initPromises);
  for (const result of initResults) {
    handles[result.inFile] = result;
  }
  return handles;
}

async function run(args: RunArgs) {
  const evaluatorOpts = {
    verbose: args.verbose,
    apiKey: args.api_key,
    orgName: args.org_name,
    apiUrl: args.api_url,
    noSendLogs: !!args.no_send_logs,
    watch: !!args.watch,
    progressReporter: args.no_progress_bars
      ? new SimpleProgressReporter()
      : new BarProgressReporter(),
    filters: args.filter ? parseFilters(args.filter) : [],
  };

  const handles = await initializeHandles(args, evaluatorOpts);

  try {
    if (!evaluatorOpts.noSendLogs) {
      await login({
        apiKey: args.api_key,
        orgName: args.org_name,
        apiUrl: args.api_url,
      });
    }
    if (args.watch) {
      await runAndWatch(handles, evaluatorOpts);
    } else {
      runOnce(handles, evaluatorOpts);
    }
  } finally {
    // ESBuild can freeze up if you do not clean up the handles properly
    for (const handle of Object.values(handles)) {
      await handle.destroy();
    }
  }
}

async function main() {
  const [, ...args] = process.argv;

  const parser = new ArgumentParser({
    description: "Argparse example",
  });

  parser.add_argument("-v", "--version", { action: "version", version });

  const parentParser = new ArgumentParser({ add_help: false });
  parentParser.add_argument("--verbose", { action: "store_true" });

  const subparser = parser.add_subparsers({
    required: true,
  });

  const parser_run = subparser.add_parser("eval", {
    help: "Run evals locally.",
    parents: [parentParser],
  });
  parser_run.add_argument("--api-key", {
    help: "Specify a braintrust api key. If the parameter is not specified, the BRAINTRUST_API_KEY environment variable will be used.",
  });
  parser_run.add_argument("--org-name", {
    help: "The name of a specific organization to connect to. This is useful if you belong to multiple.",
  });
  parser_run.add_argument("--api-url", {
    help: "Specify a custom braintrust api url. Defaults to https://www.braintrustdata.com. This is only necessary if you are using an experimental version of Braintrust",
  });
  parser_run.add_argument("--watch", {
    action: "store_true",
    help: "Watch files for changes and rerun evals when changes are detected",
  });
  parser_run.add_argument("--filter", {
    help: "Only run evaluators that match these filters. Each filter is a regular expression (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp). For example, --filter metadata.priority='^P0$' input.name='foo.*bar' will only run evaluators that have metadata.priority equal to 'P0' and input.name matching the regular expression 'foo.*bar'.",
    nargs: "*",
  });
  parser_run.add_argument("--tsconfig", {
    help: "Specify a custom tsconfig.json file to use.",
  });
  parser_run.add_argument("--no-send-logs", {
    action: "store_true",
    help: "Do not send logs to Braintrust. Useful for testing evaluators without uploading results.",
  });
  parser_run.add_argument("--no-progress-bars", {
    action: "store_true",
    help: "Do not show progress bars when processing evaluators.",
  });
  parser_run.add_argument("files", {
    nargs: "*",
    help: "A list of files or directories to run. If no files are specified, the current directory is used.",
  });
  parser_run.set_defaults({ func: run });

  const parsed = parser.parse_args();
  try {
    await parsed.func(parsed);
  } catch (e) {
    logError(e, parsed.verbose);
    process.exit(1);
  }
}

main();