import * as vscode from "vscode";
import { parseRegExpWithReplacement } from "../utils/regexp";
import { Context } from "./context";

/**
 * Runs the given string of JavaScript code.
 */
export function run(string: string, context?: object): Thenable<unknown>;

/**
 * Runs the given strings of JavaScript code.
 */
export function run(strings: readonly string[], context?: object): Thenable<unknown[]>;

export function run(strings: string | readonly string[], context: object = {}) {
  const isSingleStringArgument = typeof strings === "string";

  if (isSingleStringArgument) {
    strings = [strings as string];
  }

  const functions: ((...args: any[]) => Thenable<unknown>)[] = [];

  for (const code of strings) {
    functions.push(run.compileFunction(code, Object.keys(context)));
  }

  const parameterValues = run.parameterValues();

  if (isSingleStringArgument) {
    return functions[0](...parameterValues, ...Object.values(context));
  }

  const promises: Thenable<unknown>[] = [],
        contextValues = Object.values(context);

  for (const func of functions) {
    promises.push(func(...parameterValues, ...contextValues));
  }

  return Promise.all(promises);
}

const cachedParameterNames = [] as string[],
      cachedParameters = [] as unknown[];

function ensureCacheIsPopulated() {
  if (cachedParameterNames.length > 0) {
    return;
  }

  for (const name in exports) {
    cachedParameterNames.push(name);
    cachedParameters.push(exports[name]);
  }

  cachedParameterNames.push("vscode");
  cachedParameters.push(vscode);

  Object.freeze(cachedParameterNames);
  Object.freeze(cachedParameters);
}

export namespace run {
  /**
   * Returns the parameter names given to dynamically run functions.
   */
  export function parameterNames() {
    ensureCacheIsPopulated();

    return cachedParameterNames as readonly string[];
  }

  /**
   * Returns the parameter values given to dynamically run functions.
   */
  export function parameterValues() {
    ensureCacheIsPopulated();

    return cachedParameters as readonly unknown[];
  }

  let canRunArbitraryCode = true;

  /**
   * Disables usage of the `compileFunction` and `run` functions, preventing the
   * execution of arbitrary user inputs.
   *
   * For security purposes, execution cannot be re-enabled after calling this
   * function.
   */
  export function disable() {
    canRunArbitraryCode = false;
  }

  interface CompiledFunction {
    (...args: any[]): Thenable<unknown>;
  }

  const AsyncFunction: new (...names: string[]) => CompiledFunction
          = async function () {}.constructor as any,
        functionCache = new Map<string, CachedFunction>();

  type CachedFunction = [function: CompiledFunction, lastAccessTimestamp: number];

  /**
   * A few common inputs.
   */
  const safeExpressions = [
    /^i( + 1)?$/,
    /^`\${await register\(["']\w+["'], *[i0-9]\)}` !== ["']false["']$/,
  ];

  /**
   * Compiles the given JavaScript code into a function.
   */
  export function compileFunction(code: string, additionalParameterNames: readonly string[] = []) {
    if (!canRunArbitraryCode && !safeExpressions.some((re) => re.test(code))) {
      throw new Error("execution of arbitrary code is disabled");
    }

    const cached = functionCache.get(code);

    if (cached !== undefined) {
      cached[1] = Date.now();

      return cached[0];
    }

    let func: CompiledFunction;

    try {
      // Wrap code in block to allow shadowing of parameters.
      func = new AsyncFunction(...parameterNames(), ...additionalParameterNames, `{\n${code}\n}`);
    } catch (e) {
      throw new Error(`cannot parse function body: ${code}: ${e}`);
    }

    functionCache.set(code, [func, Date.now()]);

    return func;
  }

  /**
   * Removes all functions that were not used in the last n milliseconds from
   * the cache.
   */
  export function clearCache(olderThanMs: number): void;

  /**
   * Removes all functions that were not used in the last 5 minutes from the
   * cache.
   */
  export function clearCache(): void;

  export function clearCache(olderThanMs = 1000 * 60 * 5) {
    if (olderThanMs === 0) {
      return functionCache.clear();
    }

    const olderThan = Date.now() - olderThanMs,
          toDelete = [] as string[];

    for (const [code, value] of functionCache) {
      if (value[1] < olderThan) {
        toDelete.push(code);
      }
    }

    for (const code of toDelete) {
      functionCache.delete(code);
    }
  }
}

/**
 * Runs the VS Code command with the given identifier and optional arguments.
 */
export function command(commandName: string, ...args: readonly any[]): Thenable<any> {
  if (commandName.startsWith(".")) {
    commandName = `dance${commandName}`;
  }
  return vscode.commands.executeCommand(commandName, ...args);
}

/**
 * Runs the VS Code commands with the given identifiers and optional arguments.
 */
export async function commands(...commands: readonly command.Any[]): Promise<any[]> {
  const editorState = Context.current.editorState,
        extension = editorState.extension,
        batches = [] as (readonly CommandState[] | [string, any])[],
        currentBatch = [] as CommandState[];

  // Build and validate commands.
  for (let i = 0, len = commands.length; i < len; i++) {
    let commandName: string,
        commandArguments: any;

    const command = commands[i];

    if (typeof command === "string") {
      commandName = command;
      commandArguments = undefined;
    } else if (Array.isArray(command)) {
      commandName = command[0];
      commandArguments = command.slice(1);

      if (typeof commandName !== "string") {
        throw new Error("the first element of a command tuple must be a command name");
      }
    } else if (typeof command === "object" && command !== null) {
      commandName = (command as command.Command).command;
      commandArguments = (command as command.Command).args;

      if (typeof commandName !== "string") {
        throw new Error("the \"command\" property of a command object must be a command name");
      }
    } else {
      throw new Error(
        "commands must be command names, {command: string, args: any} objects or arrays",
      );
    }

    if (commandName.startsWith(".")) {
      commandName = `dance${commandName}`;
    }

    if (commandName in commandsByName) {
      const descriptor = commandsByName[commandName as Command],
            input = await descriptor.getInput(
              editorState,
              commandArguments,
              extension.cancellationTokenSource?.token);

      if (descriptor.input !== InputKind.None && input === undefined) {
        break;
      }

      currentBatch.push(new CommandState(descriptor, input, extension, commandArguments));
    } else {
      if (commandName.startsWith("dance.")) {
        throw new Error(`Dance command ${JSON.stringify(commandName)} does not exist`);
      }

      if (currentBatch.length > 0) {
        batches.push(currentBatch.splice(0));
      }

      batches.push([commandName, commandArguments]);
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Execute all commands.
  const results = [];

  for (const batch of batches) {
    if (typeof batch[0] === "string") {
      results.push(await vscode.commands.executeCommand(batch[0], batch[1]));
    } else {
      await CommandDescriptor.executeMany(editorState, batch);

      for (let i = 0; i < batch.length; i++) {
        results.push(undefined);
      }
    }
  }

  return results;
}

export namespace command {
  /**
   * A tuple given to `command`.
   */
  export type Tuple = readonly [commandId: string, ...args: any[]];

  /**
   * An object given to `command`.
   */
  export interface Command {
    readonly command: string;
    readonly args?: any;
  }

  export type Any = string | Tuple | Command;
}

let canExecuteArbitraryCommands = true;

/**
 * Executes a shell command.
 */
export async function execute(
  command: string,
  input?: string,
  cancellationToken: vscode.CancellationToken = Context.current.cancellationToken,
) {
  if (!canExecuteArbitraryCommands) {
    throw new Error("execution of arbitrary commands is disabled");
  }

  const cp = await import("child_process");

  return new Promise<{ readonly val: string } | { readonly err: string }>((resolve) => {
    const shell = getShell() ?? true,
          child = cp.spawn(command, { shell, stdio: "pipe" });

    let stdout = "",
        stderr = "";

    const disposable = cancellationToken.onCancellationRequested(() => {
      child.kill("SIGINT");
    });

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.stdin.end(input, "utf-8");

    child.once("error", (err) => {
      disposable.dispose();

      resolve({ err: err.message });
    });
    child.once("exit", (code) => {
      disposable.dispose();

      code === 0
        ? resolve({ val: stdout.trimRight() })
        : resolve({
          err: `Command exited with error ${code}: ${
            stderr.length > 0 ? stderr.trimRight() : "<No error output>"
          }`,
        });
    });
  });
}

export namespace execute {
  /**
   * Disables usage of the `execute` function, preventing the execution of
   * arbitrary user commands.
   *
   * For security purposes, execution cannot be re-enabled after calling this
   * function.
   */
  export function disable() {
    canExecuteArbitraryCommands = false;
  }
}

function getShell() {
  let os: string;

  if (process.platform === "cygwin") {
    os = "linux";
  } else if (process.platform === "linux") {
    os = "linux";
  } else if (process.platform === "darwin") {
    os = "osx";
  } else if (process.platform === "win32") {
    os = "windows";
  } else {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration("terminal");

  return config.get<string | null>(`integrated.automationShell.${os}`)
      ?? process.env.SHELL
      ?? undefined;
}

/**
 * Runs the given string of JavaScript code on the given input, except in two
 * cases:
 * 1. If the string is a complete RegExp expression, instead its match will be
 *    returned.
 * 2. If the string starts with "#", instead a command will be run.
 */
export function switchRun(string: string, context?: object) {
  if (string.length === 0) {
    // An empty expression is just `undefined`.
    return Promise.resolve();
  }

  if (string.startsWith("#")) {
    // Shell command.
    return execute(string.slice(1), (context as Record<string, any>)?.$);
  }

  if (string.startsWith("/") && /\/[miguys]{0,6}$/.test(string)) {
    // RegExp replace or match.
    const [regexp, replacement] = parseRegExpWithReplacement(string);

    if (replacement === undefined) {
      return Promise.resolve(regexp.exec(string));
    }

    return Promise.resolve(string.replace(regexp, replacement));
  }

  // JavaScript expression.
  return run(string, context);
}

export namespace switchRun {
  /**
   * Validates the given input string. If it is invalid, an exception will be
   * thrown.
   */
  export function validate(string: string) {
    if (string.trim().length === 0) {
      throw new Error("the given string cannot be empty");
    }

    if (string[0] === "/") {
      parseRegExpWithReplacement(string);
      return;
    }

    if (string[0] === "#") {
      if (string.slice(1).trim().length === 0) {
        throw new Error("the given shell command cannot be empty");
      }
      return;
    }

    run.compileFunction("return " + string, ["$", "i", "$$"]);
  }
}