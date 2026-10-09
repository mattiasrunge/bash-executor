/**
 * The `arg` builtin - declarative argument parsing for shell scripts.
 *
 * Syntax:
 *   arg --desc "description"           # Set command description
 *   arg <name> type "desc"             # Required positional; type: string number boolean path user group command
 *   arg [<name>] type = default "desc" # Optional positional with default
 *   arg --option type "desc"           # Named option
 *   arg --option type = default "desc" # Named option with default
 *   arg -o --option type "desc"        # Short + long option
 *   arg -f --flag "desc"               # Boolean flag
 *   arg --rest                         # Collect unconsumed args; leave them in $@ after --export
 *   arg --export                       # Parse $@ and export variables
 *   arg --effect read|write            # Whether running the script changes anything
 *   arg --writes <name> [value...]     # This argument or option makes a call a write (with these values only)
 *   arg --group                        # A dispatcher: `<script> <sub>` runs `<script>-<sub>`
 *
 * With `--rest`, args not matched by a declared spec are not errors: they are
 * left in the positional parameters ($1..$#, $@) so a dispatcher can forward
 * them, e.g. `arg '<subcommand>' string "…"; arg --rest; arg --export;
 * foo-$SUBCOMMAND "$@"`. Note: `-h`/`--help` still shows this script's help.
 */

import type { ExecContextIf } from '../types.ts';
import { makeExitSignal } from './exit.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * `path`, `user`, `group` and `command` are strings to the parser; the name says what a value is,
 * which the spec carries for a host's tab completion to offer.
 */
type ArgType = 'string' | 'number' | 'boolean' | 'path' | 'user' | 'group' | 'command';

interface PositionalArgSpec {
  kind: 'positional';
  name: string;
  type: ArgType;
  required: boolean;
  defaultValue?: string;
  description: string;
}

interface OptionArgSpec {
  kind: 'option';
  name: string;
  short?: string;
  long: string;
  type: ArgType;
  defaultValue?: string;
  description: string;
}

interface FlagArgSpec {
  kind: 'flag';
  name: string;
  short?: string;
  long: string;
  description: string;
}

type ArgSpec = PositionalArgSpec | OptionArgSpec | FlagArgSpec;

interface ArgRegistry {
  description: string;
  /** Real command lines, for a reader who has never run this script. See `arg --example`. */
  examples: string[];
  /** What the script answers with, in a sentence. See `arg --returns`. */
  returns: string;
  specs: ArgSpec[];
  /** When set, unconsumed args are collected instead of rejected, and `--export` leaves them in `$@`. */
  rest: boolean;
  /**
   * Whether running the script changes anything: `read` never does, `write` always does. A script
   * that does both is `read`, with what makes it a write in `writes`. See `arg --effect`.
   */
  effect?: 'read' | 'write';
  /** Arguments and options that make a call a write: given at all (`true`), or given one of these values. */
  writes: Map<string, true | string[]>;
  /** The script dispatches `<script> <sub>` to `<script>-<sub>`, which is what a caller should judge. */
  group: boolean;
}

// ============================================================================
// Per-context registry storage
// ============================================================================

const argRegistries = new WeakMap<ExecContextIf, ArgRegistry>();

/**
 * Traverses up the context hierarchy to find the root context.
 * This ensures all commands within a script share the same registry.
 */
function getRootContext(ctx: ExecContextIf): ExecContextIf {
  let current = ctx;
  while (current.getParent()) {
    current = current.getParent()!;
  }
  return current;
}

function getOrCreateRegistry(ctx: ExecContextIf): ArgRegistry {
  const root = getRootContext(ctx);
  let registry = argRegistries.get(root);
  if (!registry) {
    registry = { description: '', examples: [], returns: '', specs: [], rest: false, writes: new Map(), group: false };
    argRegistries.set(root, registry);
  }
  return registry;
}

// ============================================================================
// Declaration parsing
// ============================================================================

type ParseResult =
  | { type: 'desc'; description: string }
  | { type: 'example'; example: string }
  | { type: 'returns'; returns: string }
  | { type: 'export' }
  | { type: 'rest' }
  | { type: 'effect'; effect: 'read' | 'write' }
  | { type: 'writes'; name: string; values: true | string[] }
  | { type: 'group' }
  | { type: 'spec'; spec: ArgSpec }
  | { type: 'error'; message: string };

function parseArgType(s: string): ArgType | null {
  const types: ArgType[] = ['string', 'number', 'boolean', 'path', 'user', 'group', 'command'];
  return types.includes(s as ArgType) ? (s as ArgType) : null;
}

function toEnvName(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

function parsePositional(
  name: string,
  required: boolean,
  rest: string[],
): ParseResult {
  if (rest.length < 2) {
    return { type: 'error', message: `arg: missing type or description for <${name}>` };
  }

  const argType = parseArgType(rest[0]);
  if (!argType) {
    return { type: 'error', message: `arg: invalid type '${rest[0]}' for <${name}>` };
  }

  let defaultValue: string | undefined;
  let descIndex = 1;

  // Check for = default
  if (rest[1] === '=' && rest.length >= 4) {
    defaultValue = rest[2];
    descIndex = 3;
  }

  if (rest.length <= descIndex) {
    return { type: 'error', message: `arg: missing description for <${name}>` };
  }

  return {
    type: 'spec',
    spec: {
      kind: 'positional',
      name,
      type: argType,
      required,
      defaultValue,
      description: rest[descIndex],
    },
  };
}

function parseOptionOrFlag(args: string[]): ParseResult {
  let short: string | undefined;
  let long: string | undefined;
  let idx = 0;

  // Parse short option (-x)
  const shortMatch = args[idx]?.match(/^-([a-zA-Z])$/);
  if (shortMatch) {
    short = shortMatch[1];
    idx++;
  }

  // Parse long option (--name)
  const longMatch = args[idx]?.match(/^--([a-zA-Z_][a-zA-Z0-9_-]*)$/);
  if (longMatch) {
    long = longMatch[1];
    idx++;
  }

  if (!long) {
    return { type: 'error', message: 'arg: option must have a long form (--name)' };
  }

  const remaining = args.slice(idx);

  if (remaining.length === 0) {
    return { type: 'error', message: `arg: missing type or description for --${long}` };
  }

  const argType = parseArgType(remaining[0]);

  if (!argType) {
    // No type means it's a flag - remaining[0] is the description
    return {
      type: 'spec',
      spec: {
        kind: 'flag',
        name: toEnvName(long),
        short,
        long,
        description: remaining[0],
      },
    };
  }

  // It's an option with a type
  let defaultValue: string | undefined;
  let descIndex = 1;

  // Check for = default
  if (remaining[1] === '=' && remaining.length >= 4) {
    defaultValue = remaining[2];
    descIndex = 3;
  }

  if (remaining.length <= descIndex) {
    return { type: 'error', message: `arg: missing description for --${long}` };
  }

  return {
    type: 'spec',
    spec: {
      kind: 'option',
      name: toEnvName(long),
      short,
      long,
      type: argType,
      defaultValue,
      description: remaining[descIndex],
    },
  };
}

function parseArgDeclaration(args: string[]): ParseResult {
  if (args.length === 0) {
    return { type: 'error', message: 'arg: missing arguments' };
  }

  // Handle --desc
  if (args[0] === '--desc') {
    if (args.length < 2) {
      return { type: 'error', message: 'arg --desc: missing description' };
    }
    return { type: 'desc', description: args[1] };
  }

  // Handle --example / --returns: what a call looks like, and what comes back. A description
  // says what a command is FOR; only an example shows which words are positional and which
  // flags go together, and only `--returns` says whether a call gives back rows or nothing.
  if (args[0] === '--example') {
    if (args.length < 2) {
      return { type: 'error', message: 'arg --example: missing example' };
    }
    return { type: 'example', example: args[1] };
  }

  if (args[0] === '--returns') {
    if (args.length < 2) {
      return { type: 'error', message: 'arg --returns: missing description' };
    }
    return { type: 'returns', returns: args[1] };
  }

  // What a call does to the system, for a caller that must know before running it.
  if (args[0] === '--effect') {
    if (args[1] !== 'read' && args[1] !== 'write') {
      return { type: 'error', message: 'arg --effect: expected read or write' };
    }
    return { type: 'effect', effect: args[1] };
  }

  if (args[0] === '--writes') {
    if (!args[1]) {
      return { type: 'error', message: 'arg --writes: missing argument or option name' };
    }
    return { type: 'writes', name: args[1].replace(/^-+/, ''), values: args.length > 2 ? args.slice(2) : true };
  }

  if (args[0] === '--group') {
    return { type: 'group' };
  }

  // Handle --export
  if (args[0] === '--export') {
    return { type: 'export' };
  }

  // Handle --rest (collect unconsumed args and forward them via $@)
  if (args[0] === '--rest') {
    return { type: 'rest' };
  }

  // Parse positional: <name> or [<name>]
  const positionalRequired = /^<([a-zA-Z_][a-zA-Z0-9_]*)>$/;
  const positionalOptional = /^\[<([a-zA-Z_][a-zA-Z0-9_]*)>\]$/;

  let match = args[0].match(positionalRequired);
  if (match) {
    return parsePositional(match[1], true, args.slice(1));
  }

  match = args[0].match(positionalOptional);
  if (match) {
    return parsePositional(match[1], false, args.slice(1));
  }

  // Parse option/flag: starts with - or --
  if (args[0].startsWith('-')) {
    return parseOptionOrFlag(args);
  }

  return { type: 'error', message: `arg: unrecognized syntax: ${args[0]}` };
}

// ============================================================================
// Help text generation
// ============================================================================

/**
 * The declarations as a spec object, in the shape a host's command table uses.
 *
 * A positional becomes an argument, an option becomes a flag that takes a value, and a boolean
 * flag becomes one typed `bool` — the distinction a caller cannot recover from rendered help,
 * and the one a tool schema needs most: `--kind photo` and `-l` look alike in a usage block.
 */
export function generateSpec(registry: ArgRegistry, scriptName: string): Record<string, unknown> {
  const args: Record<string, unknown>[] = [];
  const flags: Record<string, unknown>[] = [];
  for (const spec of registry.specs) {
    const writes = registry.writes.get(spec.kind === 'positional' ? spec.name : spec.long);
    const marked = writes === undefined ? {} : { writes };
    if (spec.kind === 'positional') {
      args.push({ name: spec.name, type: spec.type, description: spec.description, ...(spec.required ? {} : { optional: true }), ...marked });
    } else if (spec.kind === 'option') {
      flags.push({ name: spec.long, type: spec.type, description: spec.description, ...(spec.short ? { short: spec.short } : {}), ...marked });
    } else {
      flags.push({ name: spec.long, type: 'bool', description: spec.description, ...(spec.short ? { short: spec.short } : {}), ...marked });
    }
  }
  // The name a caller would type, not the path the shell resolved it to: `$0` is the full
  // path for a script run from PATH.
  const name = scriptName.split('/').filter(Boolean).pop() || scriptName;
  return {
    name,
    ...(registry.description ? { description: registry.description } : {}),
    args,
    flags,
    ...(registry.examples.length ? { examples: registry.examples } : {}),
    ...(registry.returns ? { returns: registry.returns } : {}),
    ...(registry.effect ? { effect: registry.effect } : {}),
    ...(registry.group ? { group: true } : {}),
  };
}

function generateHelp(registry: ArgRegistry, scriptName: string): string {
  const lines: string[] = [];

  // Build usage line
  const usage: string[] = [scriptName];

  // Add [OPTIONS] if there are any options/flags
  const hasOptions = registry.specs.some((s) => s.kind === 'option' || s.kind === 'flag');
  if (hasOptions) {
    usage.push('[OPTIONS]');
  }

  // Add positionals
  for (const spec of registry.specs) {
    if (spec.kind === 'positional') {
      if (spec.required) {
        usage.push(`<${spec.name}>`);
      } else {
        usage.push(`[<${spec.name}>]`);
      }
    }
  }

  lines.push(`Usage: ${usage.join(' ')}`);
  lines.push('');

  // Description
  if (registry.description) {
    lines.push(registry.description);
    lines.push('');
  }

  // Arguments section
  const positionals = registry.specs.filter((s) => s.kind === 'positional') as PositionalArgSpec[];
  if (positionals.length > 0) {
    lines.push('Arguments:');
    for (const spec of positionals) {
      const bracket = spec.required ? `<${spec.name}>` : `[<${spec.name}>]`;
      const defaultStr = spec.defaultValue !== undefined ? ` [default: ${spec.defaultValue}]` : '';
      lines.push(`  ${bracket.padEnd(20)} ${spec.description}${defaultStr}`);
    }
    lines.push('');
  }

  // Options section
  const options = registry.specs.filter((s) => s.kind === 'option' || s.kind === 'flag');
  if (options.length > 0 || hasOptions) {
    lines.push('Options:');
    for (const spec of options) {
      const shortPart = spec.short ? `-${spec.short}, ` : '    ';
      const longPart = `--${spec.long}`;
      let typePart = '';
      let defaultStr = '';
      if (spec.kind === 'option') {
        typePart = ` <${spec.type}>`;
        if (spec.defaultValue !== undefined) {
          defaultStr = ` [default: ${spec.defaultValue}]`;
        }
      }
      const flagStr = `${shortPart}${longPart}${typePart}`;
      lines.push(`  ${flagStr.padEnd(24)} ${spec.description}${defaultStr}`);
    }
    // Always include -h/--help
    lines.push('  -h, --help                 Show this help message');
    lines.push('');
  }

  if (registry.returns) {
    lines.push('Returns:');
    lines.push(`  ${registry.returns}`);
    lines.push('');
  }

  if (registry.examples.length > 0) {
    lines.push('Examples:');
    for (const example of registry.examples) {
      lines.push(`  ${example}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Argument parsing at --export time
// ============================================================================

interface ArgumentParseResult {
  values: Record<string, string>;
  errors: string[];
  helpRequested: boolean;
  /** Args not consumed by any declared spec (only populated when `registry.rest` is set). */
  restArgs: string[];
}

function parseArguments(registry: ArgRegistry, rawArgs: string[]): ArgumentParseResult {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const restArgs: string[] = [];
  const rest = registry.rest;
  let helpRequested = false;

  const positionalSpecs = registry.specs.filter((s) => s.kind === 'positional') as PositionalArgSpec[];
  const optionSpecs = registry.specs.filter((s) => s.kind === 'option') as OptionArgSpec[];
  const flagSpecs = registry.specs.filter((s) => s.kind === 'flag') as FlagArgSpec[];

  // Build lookup maps
  const longOptionMap = new Map<string, OptionArgSpec | FlagArgSpec>();
  const shortOptionMap = new Map<string, OptionArgSpec | FlagArgSpec>();

  for (const spec of [...optionSpecs, ...flagSpecs]) {
    longOptionMap.set(spec.long, spec);
    if (spec.short) {
      shortOptionMap.set(spec.short, spec);
    }
  }

  // Initialize flags to empty (false in shell context)
  for (const spec of flagSpecs) {
    values[spec.name] = '';
  }

  // Parse arguments
  let positionalIndex = 0;
  let i = 0;

  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    // Check for help
    if (arg === '-h' || arg === '--help') {
      helpRequested = true;
      i++;
      continue;
    }

    // Check for -- (end of options)
    if (arg === '--') {
      i++;
      // All remaining args are positionals
      while (i < rawArgs.length) {
        if (positionalIndex < positionalSpecs.length) {
          const spec = positionalSpecs[positionalIndex];
          values[toEnvName(spec.name)] = rawArgs[i];
          positionalIndex++;
        } else if (rest) {
          restArgs.push(rawArgs[i]);
        } else {
          errors.push(`Unexpected argument: ${rawArgs[i]}`);
        }
        i++;
      }
      break;
    }

    // Check for long option (--name or --name=value)
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      let optName: string;
      let optValue: string | undefined;

      if (eqIndex !== -1) {
        optName = arg.slice(2, eqIndex);
        optValue = arg.slice(eqIndex + 1);
      } else {
        optName = arg.slice(2);
      }

      const spec = longOptionMap.get(optName);

      if (!spec) {
        if (rest) restArgs.push(arg);
        else errors.push(`Unknown option: --${optName}`);
        i++;
        continue;
      }

      if (spec.kind === 'flag') {
        if (optValue !== undefined) {
          errors.push(`Flag --${optName} does not take a value`);
        }
        values[spec.name] = '1';
        i++;
      } else {
        // Option requires value
        if (optValue !== undefined) {
          // Value was provided with =
          if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(optValue)) {
            errors.push(`Option --${optName} requires a numeric value, got: ${optValue}`);
          } else {
            values[spec.name] = optValue;
          }
          i++;
        } else if (i + 1 >= rawArgs.length) {
          errors.push(`Option --${optName} requires a value`);
          i++;
        } else {
          const nextValue = rawArgs[i + 1];
          if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(nextValue)) {
            errors.push(`Option --${optName} requires a numeric value, got: ${nextValue}`);
          } else {
            values[spec.name] = nextValue;
          }
          i += 2;
        }
      }
      continue;
    }

    // Check for short option (-x or -x value)
    if (arg.startsWith('-') && arg.length === 2) {
      const optChar = arg[1];
      const spec = shortOptionMap.get(optChar);

      if (!spec) {
        if (rest) restArgs.push(arg);
        else errors.push(`Unknown option: -${optChar}`);
        i++;
        continue;
      }

      if (spec.kind === 'flag') {
        values[spec.name] = '1';
        i++;
      } else {
        // Option requires value
        if (i + 1 >= rawArgs.length) {
          errors.push(`Option -${optChar} requires a value`);
          i++;
          continue;
        }
        const nextValue = rawArgs[i + 1];
        if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(nextValue)) {
          errors.push(`Option -${optChar} requires a numeric value, got: ${nextValue}`);
        } else {
          values[spec.name] = nextValue;
        }
        i += 2;
      }
      continue;
    }

    // Positional argument
    if (positionalIndex < positionalSpecs.length) {
      const spec = positionalSpecs[positionalIndex];
      const envName = toEnvName(spec.name);

      if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(arg)) {
        errors.push(`Argument <${spec.name}> requires a numeric value, got: ${arg}`);
      } else {
        values[envName] = arg;
      }
      positionalIndex++;
    } else if (rest) {
      restArgs.push(arg);
    } else {
      errors.push(`Unexpected argument: ${arg}`);
    }
    i++;
  }

  // Apply defaults and check required positionals
  for (let j = 0; j < positionalSpecs.length; j++) {
    const spec = positionalSpecs[j];
    const envName = toEnvName(spec.name);

    if (!(envName in values)) {
      if (spec.defaultValue !== undefined) {
        values[envName] = spec.defaultValue;
      } else if (spec.required) {
        errors.push(`Missing required argument: <${spec.name}>`);
      } else {
        values[envName] = '';
      }
    }
  }

  // Apply option defaults
  for (const spec of optionSpecs) {
    if (!(spec.name in values)) {
      if (spec.defaultValue !== undefined) {
        values[spec.name] = spec.defaultValue;
      } else {
        values[spec.name] = '';
      }
    }
  }

  return { values, errors, helpRequested, restArgs };
}

// ============================================================================
// Main builtin handler
// ============================================================================

export const argBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell,
  _execute,
): Promise<BuiltinResult> => {
  const parsed = parseArgDeclaration(args);

  switch (parsed.type) {
    case 'error':
      return { code: 1, stderr: `${parsed.message}\n` };

    case 'desc': {
      const registry = getOrCreateRegistry(ctx);
      registry.description = parsed.description;
      return { code: 0 };
    }

    case 'example': {
      const registry = getOrCreateRegistry(ctx);
      registry.examples.push(parsed.example);
      return { code: 0 };
    }

    case 'returns': {
      const registry = getOrCreateRegistry(ctx);
      registry.returns = parsed.returns;
      return { code: 0 };
    }

    case 'rest': {
      const registry = getOrCreateRegistry(ctx);
      registry.rest = true;
      return { code: 0 };
    }

    case 'effect': {
      getOrCreateRegistry(ctx).effect = parsed.effect;
      return { code: 0 };
    }

    case 'writes': {
      getOrCreateRegistry(ctx).writes.set(parsed.name, parsed.values);
      return { code: 0 };
    }

    case 'group': {
      getOrCreateRegistry(ctx).group = true;
      return { code: 0 };
    }

    case 'spec': {
      const registry = getOrCreateRegistry(ctx);
      registry.specs.push(parsed.spec);
      return { code: 0 };
    }

    case 'export': {
      const root = getRootContext(ctx);
      const registry = argRegistries.get(root);

      if (!registry) {
        return { code: 0 }; // `arg --export` with nothing declared at all
      }

      // NOT `specs.length === 0`: a script that declares only a description, forwarding every
      // argument to another command, still has help to give. Only the parse-and-export half
      // below needs declared arguments.

      // Extract raw positional arguments from context
      const params = ctx.getParams();
      const rawArgs: string[] = [];

      // Get count from '#'
      const count = parseInt(params['#'] || '0', 10);
      for (let i = 1; i <= count; i++) {
        const arg = params[String(i)];
        if (arg !== undefined) {
          rawArgs.push(arg);
        }
      }

      const result = parseArguments(registry, rawArgs);

      // Handle help request - EXIT the script
      if (result.helpRequested) {
        const scriptName = params['0'] || 'script';
        // Asked in JSON, answer with the declarations themselves rather than the rendered help:
        // a caller that asks for JSON wants the structure, not a usage block to parse.
        const helpText = ctx.getEnv().JSON_OUTPUT === '1' ? JSON.stringify(generateSpec(registry, scriptName)) : generateHelp(registry, scriptName);

        // Clean up registry
        argRegistries.delete(root);

        return { code: makeExitSignal(0), stdout: helpText };
      }

      if (registry.specs.length === 0) {
        // Nothing declared to parse: leave $@ exactly as it was.
        argRegistries.delete(root);
        return { code: 0 };
      }

      // Handle errors
      if (result.errors.length > 0) {
        const scriptName = params['0'] || 'script';
        let stderr = result.errors.map((e) => `${scriptName}: ${e}`).join('\n') + '\n';
        stderr += `Try '${scriptName} --help' for more information.\n`;

        // Clean up registry
        argRegistries.delete(root);

        return { code: makeExitSignal(1), stderr };
      }

      // Export values as environment variables
      ctx.setEnv(result.values);

      // In rest mode, replace the positional parameters with the unconsumed
      // args so a dispatcher can forward them verbatim via "$@" (e.g.
      // `foo-$SUBCOMMAND "$@"`). Mirrors what `shift` does to $1..$#.
      if (registry.rest) {
        const updates: Record<string, string | null> = {};
        for (const key of Object.keys(params)) {
          if (/^[1-9][0-9]*$/.test(key)) updates[key] = null;
        }
        result.restArgs.forEach((value, idx) => {
          updates[String(idx + 1)] = value;
        });
        updates['#'] = String(result.restArgs.length);
        updates['@'] = result.restArgs.join(' ');
        updates['*'] = result.restArgs.join(' ');
        ctx.setParams(updates);
      }

      // Clean up registry after export
      argRegistries.delete(root);

      return { code: 0 };
    }

    default:
      return { code: 1, stderr: 'arg: internal error\n' };
  }
};
