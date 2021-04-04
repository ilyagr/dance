import * as vscode from "vscode";
import { Register } from "../register";
import { Context } from "./context";

/**
 * Returns the `i`th string in the register with the given name, or `undefined`
 * if no value is available.
 */
export function register(name: string, i: number): Thenable<string | undefined>;

/**
 * Returns the strings in the register with the given name, or `undefined` if no
 * values are available.
 */
export function register(name: string): Thenable<readonly string[] | undefined>;

export function register(name: string, i?: number) {
  const register = Context.current.extensionState.registers.get(name);

  Register.assertFlags(register, Register.Flags.CanRead);

  if (i === undefined) {
    return register.get();
  }

  return register.get().then((values) => values?.[i]);
}

export namespace register {
  /**
   * Returns the `i`th selection in the register with the given name, or
   * `undefined` if no selection is available.
   */
  export function selection(name: string, i: number): Thenable<vscode.Selection | undefined>;

  /**
   * Returns the selections in the register with the given name, or `undefined`
   * if no selections are available.
   */
  export function selection(name: string): Thenable<readonly vscode.Selection[] | undefined>;

  export function selection(name: string, i?: number): any {
    const register = Context.current.extensionState.registers.get(name);

    Register.assertFlags(register, Register.Flags.CanReadSelections);

    if (i === undefined) {
      return Promise.resolve(register.getSelections());
    }

    return Promise.resolve(register.getSelections()?.[i]);
  }
}