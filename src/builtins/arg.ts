/**
 * The `arg` builtin - declarative argument parsing for shell scripts.
 *
 * Syntax:
 *   arg --desc "description"           # Set command description
 *   arg <name> type "desc"             # Required positional
 *   arg [<name>] type = default "desc" # Optional positional with default
 *   arg --option type "desc"           # Named option
 *   arg --option type = default "desc" # Named option with default
 *   arg -o --option type "desc"        # Short + long option
 *   arg -f --flag "desc"               # Boolean flag
 *   arg --export                       # Parse $@ and export variables
 */

import type { ExecContextIf } from '../types.ts';
import { makeExitSignal } from './exit.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

// ============================================================================
// Types
// ============================================================================

type ArgType = 'string' | 'number' | 'boolean';

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
  specs: ArgSpec[];
}

// ============================================================================
// Per-context registry storage
// ============================================================================

const argRegistries = new WeakMap<ExecContextIf, ArgRegistry>();

function getOrCreateRegistry(ctx: ExecContextIf): ArgRegistry {
  let registry = argRegistries.get(ctx);
  if (!registry) {
    registry = { description: '', specs: [] };
    argRegistries.set(ctx, registry);
  }
  return registry;
}

// ============================================================================
// Declaration parsing
// ============================================================================

type ParseResult =
  | { type: 'desc'; description: string }
  | { type: 'export' }
  | { type: 'spec'; spec: ArgSpec }
  | { type: 'error'; message: string };

function parseArgType(s: string): ArgType | null {
  const types: ArgType[] = ['string', 'number', 'boolean'];
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

  // Handle --export
  if (args[0] === '--export') {
    return { type: 'export' };
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

  return lines.join('\n');
}

// ============================================================================
// Argument parsing at --export time
// ============================================================================

interface ArgumentParseResult {
  values: Record<string, string>;
  errors: string[];
  helpRequested: boolean;
}

function parseArguments(registry: ArgRegistry, rawArgs: string[]): ArgumentParseResult {
  const values: Record<string, string> = {};
  const errors: string[] = [];
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
        errors.push(`Unknown option: --${optName}`);
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
        errors.push(`Unknown option: -${optChar}`);
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

  return { values, errors, helpRequested };
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

    case 'spec': {
      const registry = getOrCreateRegistry(ctx);
      registry.specs.push(parsed.spec);
      return { code: 0 };
    }

    case 'export': {
      const registry = argRegistries.get(ctx);
      if (!registry || registry.specs.length === 0) {
        return { code: 0 }; // No args defined, nothing to do
      }

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
        const helpText = generateHelp(registry, scriptName);

        // Clean up registry
        argRegistries.delete(ctx);

        return { code: makeExitSignal(0), stdout: helpText };
      }

      // Handle errors
      if (result.errors.length > 0) {
        const scriptName = params['0'] || 'script';
        let stderr = result.errors.map((e) => `${scriptName}: ${e}`).join('\n') + '\n';
        stderr += `Try '${scriptName} --help' for more information.\n`;

        // Clean up registry
        argRegistries.delete(ctx);

        return { code: makeExitSignal(1), stderr };
      }

      // Export values as environment variables
      ctx.setEnv(result.values);

      // Clean up registry after export
      argRegistries.delete(ctx);

      return { code: 0 };
    }

    default:
      return { code: 1, stderr: 'arg: internal error\n' };
  }
};
