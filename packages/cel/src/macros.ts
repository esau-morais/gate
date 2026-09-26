import { evaluationError, parseError } from './errors';
import { OPERATORS as OPS } from './operators';
import { expectDefined, isPromise, truthy } from './globals';
import type { Evaluator } from './evaluator';
import type {
  AnyNode,
  CallNode,
  FieldNode,
  IdNode,
  MacroInput,
  RcallNode,
} from './parser';
import type {
  EvalContext,
  OverlayContext,
  Registry,
  RegisteredFunctionHandler,
  TypeDeclaration,
} from './registry';
import type { TypeChecker } from './type-checker';

const identity = (x: unknown): unknown => x;

function assertIdentifier(node: AnyNode | undefined, message: string): string {
  const n = expectDefined(node, 'macro argument');
  if (n.op === 'id') {
    return n.args;
  }

  throw parseError('invalid_macro_argument', message, n);
}

function createMapExpander(hasFilter: boolean) {
  const functionDesc = hasFilter
    ? 'map(var, filter, transform)'
    : 'map(var, transform)';
  const invalidMsg = `${functionDesc} invalid predicate iteration variable`;
  const label = `${functionDesc} filter predicate must return bool`;

  return ({ args, receiver, ast: callAst }: MacroInput): MacroExpansion => {
    const iterVar = args[0];
    const predicate = hasFilter ? expectDefined(args[1], 'map filter') : null;
    const transform = expectDefined(
      hasFilter ? args[2] : args[1],
      'map transform',
    );

    let step: AnyNode = transform.clone(OPS.accuPush, transform);
    if (predicate) {
      const accuValue = predicate.clone(OPS.accuValue, undefined);
      step = predicate.clone(OPS.ternary, [
        predicate.setMeta('label', label),
        step,
        accuValue,
      ]);
    }

    return {
      callAst: callAst.clone(OPS.comprehension, {
        errorsAreFatal: true,
        iterable: expectDefined(receiver, 'map receiver'),
        iterVarName: assertIdentifier(iterVar, invalidMsg),
        init: callAst.clone(OPS.list, []),
        step,
        result: identity,
      }),
    };
  };
}

function createFilterExpander() {
  const functionDesc = 'filter(var, predicate)';
  const invalidMsg = `${functionDesc} invalid predicate iteration variable`;
  const label = `${functionDesc} predicate must return bool`;

  return ({ args, receiver, ast: callAst }: MacroInput): MacroExpansion => {
    const iterVarName = assertIdentifier(args[0], invalidMsg);
    const accuValue = callAst.clone(OPS.accuValue, undefined);
    const predicate = expectDefined(args[1], 'filter predicate').setMeta(
      'label',
      label,
    );
    const appendItem = callAst.clone(
      OPS.accuPush,
      callAst.clone(OPS.id, iterVarName),
    );
    const step = predicate.clone(OPS.ternary, [
      predicate,
      appendItem,
      accuValue,
    ]);

    return {
      callAst: callAst.clone(OPS.comprehension, {
        errorsAreFatal: true,
        iterable: expectDefined(receiver, 'filter receiver'),
        iterVarName,
        init: callAst.clone(OPS.list, []),
        step,
        result: identity,
      }),
    };
  };
}

interface MacroExpansion {
  callAst: AnyNode;
}

interface QuantifierTransform {
  init: AnyNode;
  condition?: ((accu: unknown) => unknown) | undefined;
  step: AnyNode;
  result?: ((accu: unknown) => unknown) | undefined;
}

interface QuantifierOptions {
  name: string;
  errorsAreFatal?: boolean;
  condition?: (accu: unknown) => unknown;
  result?: (accu: unknown) => unknown;
  transform(input: {
    args: AnyNode[];
    ast: CallNode | RcallNode;
    predicate: AnyNode;
    opts: QuantifierOptions;
  }): QuantifierTransform;
}

function createQuantifierExpander(opts: QuantifierOptions) {
  const invalidMsg = `${opts.name}(var, predicate) invalid predicate iteration variable`;
  const label = `${opts.name}(var, predicate) predicate must return bool`;

  return ({ args, receiver, ast: callAst }: MacroInput): MacroExpansion => {
    const predicate = expectDefined(args[1], 'quantifier predicate').setMeta(
      'label',
      label,
    );
    const transform = opts.transform({ args, ast: callAst, predicate, opts });

    return {
      callAst: callAst.clone(OPS.comprehension, {
        kind: 'quantifier',
        errorsAreFatal: opts.errorsAreFatal === true,
        iterable: expectDefined(receiver, 'quantifier receiver'),
        iterVarName: assertIdentifier(args[0], invalidMsg),
        init: transform.init,
        condition: transform.condition,
        step: transform.step,
        result: transform.result ?? identity,
      }),
    };
  };
}

interface HasMacro {
  args: AnyNode[];
  evaluate(ev: Evaluator, macro: HasMacro, ctx: EvalContext): unknown;
  typeCheck(
    checker: TypeChecker,
    macro: HasMacro,
    ctx: EvalContext,
  ): TypeDeclaration;
  async: false;
  /** Field selections from outermost to innermost, then the root identifier. Set by typeCheck. */
  macroHasProps?: (FieldNode | IdNode)[];
}

function createHasExpander() {
  const invalidHasArgument = 'has() invalid argument';

  function evaluate(ev: Evaluator, macro: HasMacro, ctx: EvalContext): unknown {
    const nodes = expectDefined(macro.macroHasProps, 'has() selection');
    let i = nodes.length;
    let obj = ev.run(expectDefined(nodes[--i], 'has() root'), ctx);
    let inOptionalContext: boolean | undefined;
    while (i-- !== 0) {
      const node = expectDefined(nodes[i], 'has() selection');
      if (node.op === '.?') {
        inOptionalContext ??= true;
      }

      obj = ev.debugType(obj).fieldLazy(obj, node.args[1], node, ev);
      if (obj !== undefined) {
        continue;
      }

      if (!(inOptionalContext !== true && i !== 0 && node.op === '.')) {
        break;
      }

      throw evaluationError(
        'no_such_key',
        `No such key: ${String(node.args[1])}`,
        node,
      );
    }

    return obj !== undefined;
  }

  function typeCheck(
    checker: TypeChecker,
    macro: HasMacro,
    ctx: EvalContext,
  ): TypeDeclaration {
    let node = expectDefined(macro.args[0], 'has() argument');
    if (node.op !== '.') {
      throw checker.createError(
        'invalid_macro_argument',
        invalidHasArgument,
        node,
      );
    }

    if (!macro.macroHasProps) {
      const props: (FieldNode | IdNode)[] = [];
      while (node.op === '.' || node.op === '.?') {
        props.push(node);
        node = node.args[0];
      }

      if (node.op !== 'id') {
        throw checker.createError(
          'invalid_macro_argument',
          invalidHasArgument,
          node,
        );
      }

      checker.check(node, ctx);
      props.push(node);
      macro.macroHasProps = props;
    }

    return checker.getType('bool');
  }

  return function ({ args }: MacroInput): HasMacro {
    return { args, evaluate, typeCheck, async: false };
  };
}

interface BindMacro {
  ast: CallNode | RcallNode;
  var: string;
  val: AnyNode;
  exp: AnyNode;
  bindCtx: OverlayContext | undefined;
  typeCheck(
    checker: TypeChecker,
    m: BindMacro,
    ctx: EvalContext,
  ): TypeDeclaration;
  evaluate(ev: Evaluator, m: BindMacro, ctx: EvalContext): unknown;
}

export function registerMacros(registry: Registry): void {
  const functionOverload = (
    sig: string,
    handler: RegisteredFunctionHandler,
  ): void => registry.registerFunctionOverload(sig, handler);

  functionOverload('has(ast): bool', createHasExpander());

  functionOverload(
    'list.all(ast, ast): bool',
    createQuantifierExpander({
      name: 'all',
      transform({ ast: callAst, predicate }) {
        return {
          init: callAst.clone(OPS.value, true),
          condition: identity,
          step: predicate.clone(OPS.ternary, [
            predicate,
            predicate.clone(OPS.value, true),
            predicate.clone(OPS.value, false),
          ]),
        };
      },
    }),
  );

  functionOverload(
    'list.exists(ast, ast): bool',
    createQuantifierExpander({
      name: 'exists',
      condition(accu) {
        return !truthy(accu);
      },
      transform({ ast: callAst, predicate, opts }) {
        return {
          init: callAst.clone(OPS.value, false),
          condition: opts.condition,
          step: predicate.clone(OPS.ternary, [
            predicate,
            predicate.clone(OPS.value, true),
            predicate.clone(OPS.value, false),
          ]),
        };
      },
    }),
  );

  functionOverload(
    'list.exists_one(ast, ast): bool',
    createQuantifierExpander({
      name: 'exists_one',
      errorsAreFatal: true,
      result(accu) {
        return accu === 1;
      },
      transform({ ast: callAst, predicate, opts }) {
        const accuValue = callAst.clone(OPS.accuValue, undefined);

        return {
          init: callAst.clone(OPS.value, 0),
          step: predicate.clone(OPS.ternary, [
            predicate,
            callAst.clone(OPS.accuInc, undefined),
            accuValue,
          ]),
          result: opts.result,
        };
      },
    }),
  );

  functionOverload('list.map(ast, ast): list<dyn>', createMapExpander(false));
  functionOverload(
    'list.map(ast, ast, ast): list<dyn>',
    createMapExpander(true),
  );
  functionOverload('list.filter(ast, ast): list<dyn>', createFilterExpander());

  class CelNamespace {}
  const celNamespace = new CelNamespace();
  registry.registerType('CelNamespace', CelNamespace);
  registry.registerConstant('cel', 'CelNamespace', celNamespace);

  function bindTypeCheck(
    checker: TypeChecker,
    m: BindMacro,
    ctx: EvalContext,
  ): TypeDeclaration {
    const bindCtx = (m.bindCtx = ctx.forkWithVariable(
      m.var,
      checker.check(m.val, ctx),
    ));
    const type = checker.check(m.exp, bindCtx);
    if (m.val.maybeAsync || m.exp.maybeAsync) {
      return type;
    }

    m.ast.setMeta('async', false);
    m.evaluate = bindEvaluateSync;

    return type;
  }

  function bindOptionalEvaluate(
    ev: Evaluator,
    exp: AnyNode,
    bindCtx: OverlayContext,
    ctx: EvalContext,
    boundValue: unknown,
  ): unknown {
    const scope = bindCtx.reuse(ctx).setIterValue(boundValue, ev);
    const res = ev.run(exp, scope);
    if (isPromise(res) && scope === bindCtx) {
      scope.async = true;
    }

    return res;
  }

  function bindEvaluate(
    ev: Evaluator,
    { val, exp, bindCtx }: BindMacro,
    ctx: EvalContext,
  ): unknown {
    const v = ev.run(val, ctx);
    const scope = expectDefined(bindCtx, 'bind context');
    if (isPromise(v)) {
      return v.then((_v: unknown) =>
        bindOptionalEvaluate(ev, exp, scope, ctx, _v),
      );
    }

    return bindOptionalEvaluate(ev, exp, scope, ctx, v);
  }

  function bindEvaluateSync(
    ev: Evaluator,
    { val, exp, bindCtx }: BindMacro,
    ctx: EvalContext,
  ): unknown {
    return ev.run(
      exp,
      expectDefined(bindCtx, 'bind context')
        .reuse(ctx)
        .setIterValue(ev.run(val, ctx), ev),
    );
  }

  functionOverload(
    'CelNamespace.bind(ast, dyn, ast): dyn',
    ({ ast, args }: MacroInput): BindMacro => {
      return {
        ast,
        var: assertIdentifier(args[0], 'invalid variable argument'),
        val: expectDefined(args[1], 'bind value'),
        exp: expectDefined(args[2], 'bind expression'),
        bindCtx: undefined,
        typeCheck: bindTypeCheck,
        evaluate: bindEvaluate,
      };
    },
  );
}
