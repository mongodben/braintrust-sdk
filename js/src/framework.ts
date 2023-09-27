import { Experiment } from "./logger";
import { Score } from "autoevals";
import { ProgressReporter } from "./progress";

export type Metadata = Record<string, unknown>;

export interface EvalCase<Input, Output> {
  input: Input;
  expected?: Output;
  metadata?: Metadata;
}

export type EvalData<Input, Output> =
  | (() => EvalCase<Input, Output>[])
  | (() => Promise<EvalCase<Input, Output>[]>);

export type EvalTask<Input, Output> =
  | ((input: Input, hooks: EvalHooks) => Promise<Output>)
  | ((input: Input, hooks: EvalHooks) => Output);

export interface EvalHooks {
  meta: (info: Record<string, unknown>) => void;
}

// This happens to be compatible with ScorerArgs defined in autoevals
export type EvalScorerArgs<Input, Output> = EvalCase<Input, Output> & {
  output: Output;
};

export type EvalScorer<Input, Output> =
  | ((args: EvalScorerArgs<Input, Output>) => Score)
  | ((args: EvalScorerArgs<Input, Output>) => Promise<Score>);

/**
 * An evaluator is a collection of functions that can be used to evaluate a model.
 * It consists of:
 * - `data`, a function that returns a list of inputs, expected outputs, and metadata
 * - `task`, a function that takes an input and returns an output
 * - `scores`, a set of functions that take an input, output, and expected value and return a score
 */
export interface Evaluator<Input, Output> {
  data: EvalData<Input, Output>;
  task: EvalTask<Input, Output>;
  scores: EvalScorer<Input, Output>[];
}

export type EvaluatorDef<Input, Output> = {
  name: string;
} & Evaluator<Input, Output>;

export type EvaluatorFile = {
  [evaluator: string]: EvaluatorDef<any, any>;
};

declare global {
  var _evals: EvaluatorFile;
}

globalThis._evals = {};

export function Eval<Input, Output>(
  name: string,
  evaluator: Evaluator<Input, Output>
) {
  if (_evals[name]) {
    throw new Error(`Evaluator ${name} already exists`);
  }
  _evals[name] = { name, ...evaluator };
}

export function getLoadedEvals() {
  return _evals;
}

export interface Filter {
  path: string[];
  pattern: RegExp;
}

export function serializeJSONWithPlainString(v: any) {
  if (typeof v === "string") {
    return v;
  } else {
    return JSON.stringify(v);
  }
}

export function deserializePlainStringAsJSON(s: string) {
  try {
    return { value: JSON.parse(s), error: undefined };
  } catch (e) {
    return { value: s, error: e };
  }
}

export function parseFilters(filters: string[]): Filter[] {
  const result: Filter[] = [];
  for (const f of filters) {
    const equalsIdx = f.indexOf("=");
    if (equalsIdx === -1) {
      throw new Error(`Invalid filter ${f}`);
    }
    const [path, value] = [f.slice(0, equalsIdx), f.slice(equalsIdx + 1)];
    let deserializedValue = deserializePlainStringAsJSON(value).value;
    if (typeof deserializedValue !== "string") {
      deserializedValue = value; // Just fall back to the original input
    }
    result.push({
      path: path.split("."),
      pattern: new RegExp(deserializedValue),
    });
  }
  return result;
}

function evaluateFilter(object: any, filter: Filter) {
  const { path, pattern } = filter;
  const key = path.reduce((acc, p) => acc?.[p], object);
  if (key === undefined) {
    return false;
  }
  return pattern.test(serializeJSONWithPlainString(key));
}

export async function runEvaluator(
  experiment: Experiment | null,
  evaluator: EvaluatorDef<unknown, unknown>,
  progressReporter: ProgressReporter,
  filters: Filter[]
) {
  if (typeof evaluator.data === "string") {
    throw new Error("Unimplemented: string data paths");
  }
  const dataResult = evaluator.data();
  let data = null;
  if (dataResult instanceof Promise) {
    data = await dataResult;
  } else {
    data = dataResult;
  }

  data = data.filter((d) => filters.every((f) => evaluateFilter(d, f)));

  progressReporter.start(evaluator.name, data.length);

  const evals = data.map(async (datum) => {
    let metadata: Metadata = { ...datum.metadata };
    let output = undefined;
    let error = undefined;
    let scores: Record<string, number> = {};
    try {
      const meta = (o: Record<string, unknown>) =>
        (metadata = { ...metadata, ...o });

      const outputResult = evaluator.task(datum.input, {
        meta,
      });
      if (outputResult instanceof Promise) {
        output = await outputResult;
      } else {
        output = outputResult;
      }

      const scoringArgs = { ...datum, metadata, output };
      const scoreResults = await Promise.all(
        evaluator.scores.map(async (score) => {
          const scoreResult = score(scoringArgs);
          if (scoreResult instanceof Promise) {
            return await scoreResult;
          } else {
            return scoreResult;
          }
        })
      );

      const scoreMetadata: Record<string, unknown> = {};
      for (const scoreResult of scoreResults) {
        scores[scoreResult.name] = scoreResult.score;
        const metadata = {
          ...scoreResult.metadata,
        };
        if (scoreResult.error !== undefined) {
          metadata.error = scoreResult.error;
        }
        if (Object.keys(metadata).length > 0) {
          scoreMetadata[scoreResult.name] = metadata;
        }
      }

      if (Object.keys(scoreMetadata).length > 0) {
        meta({ scores: scoreMetadata });
      }
    } catch (e) {
      error = e;
    } finally {
      progressReporter.increment(evaluator.name);
    }

    if (experiment && !error) {
      experiment.log({
        // TODO We should rename this from inputs -> input in the logger, etc.
        // https://github.com/braintrustdata/braintrust/issues/217
        input: datum.input,
        metadata: metadata,
        expected: datum.expected,
        output,
        scores,
      });
    }
    return {
      output,
      metadata,
      scores,
      error,
    };
  });
  const results = await Promise.all(evals);
  const summary = experiment ? await experiment.summarize() : null;
  return {
    results,
    summary,
  };
}