import { attachErrorAst, evaluationError, typeError } from './errors';
import { expectDefined } from './globals';
import { Base } from './operators';
import type { BaseOptions } from './operators';
import type { AccessNode, AnyNode } from './parser';
import type { EvalContext, Registry, TypeDeclaration } from './registry';

const toDynTypeBinding: ReadonlyMap<string, string> = new Map()
  .set('A', 'dyn')
  .set('T', 'dyn')
  .set('K', 'dyn')
  .set('V', 'dyn');

function templatedName(
  r: Registry,
  type: TypeDeclaration | string,
): TypeDeclaration | string {
  if (typeof type === 'string' || !type.hasPlaceholderType) {
    return type;
  }

  const inner = (t: TypeDeclaration | undefined): string => {
    const templated = templatedName(r, expectDefined(t, 'type parameter'));

    return typeof templated === 'string' ? templated : templated.name;
  };

  switch (type.kind) {
    case 'dyn':
      return templatedName(r, expectDefined(type.valueType, 'dyn value type'));
    case 'param':
      return toDynTypeBinding.get(type.name) ?? type;
    case 'map':
      return r.getType(`map<${inner(type.keyType)}, ${inner(type.valueType)}>`);
    case 'list':
      return r.getType(`list<${inner(type.valueType)}>`);
    case 'optional':
      return r.getType(`optional<${inner(type.valueType)}>`);
    case 'primitive':
    case 'message':
    case 'enum':
      return type;
  }
}

/**
 * TypeChecker performs static type analysis on CEL expressions
 * without executing them. It validates:
 * - Variable existence and types
 * - Function signatures and overloads
 * - Operator compatibility using the actual overload registry
 * - Property and index access validity
 */
export class TypeChecker extends Base {
  constructor(opts: BaseOptions, isEvaluating?: boolean) {
    super(opts);
    this.createError = isEvaluating === true ? evaluationError : typeError;
  }

  /**
   * Check an expression and return its inferred type
   * @param ast - The AST node to check
   * @returns The inferred type declaration
   * @throws {TypeError} If type checking fails
   */
  check(ast: AnyNode, ctx: EvalContext): TypeDeclaration {
    try {
      return (ast.checkedType ??= ast.check(this, ast, ctx));
    } catch (error) {
      throw attachErrorAst(error, ast);
    }
  }

  checkAccessOnType(
    ast: AccessNode,
    ctx: EvalContext,
    leftType: TypeDeclaration,
    allowMissingField = false,
  ): TypeDeclaration {
    if (leftType === this.dynType) {
      return leftType;
    }

    const indexTypeName = (
      ast.op === '[]' || ast.op === '[?]'
        ? this.check(ast.args[1], ctx)
        : this.stringType
    ).type;

    if (leftType.kind === 'list') {
      if (indexTypeName === 'int' || indexTypeName === 'dyn') {
        return expectDefined(leftType.valueType, 'list value type');
      }

      throw this.createError(
        'invalid_index_type',
        `List index must be int, got '${indexTypeName}'`,
        ast,
      );
    }

    if (leftType.kind === 'map') {
      return expectDefined(leftType.valueType, 'map value type');
    }

    const customType = this.objectTypes.get(leftType.name);
    if (customType) {
      if (!(indexTypeName === 'string' || indexTypeName === 'dyn')) {
        throw this.createError(
          'invalid_index_type',
          `Cannot index type '${leftType.name}' with type '${indexTypeName}'`,
          ast,
        );
      }

      if (customType.fields) {
        let keyName: unknown;
        const index = ast.args[1];
        if (ast.op === '.' || ast.op === '.?') {
          keyName = index;
        } else if (typeof index !== 'string' && index.op === 'value') {
          keyName = index.args;
        }

        if (typeof keyName === 'string') {
          const fieldType = customType.fields[keyName];
          if (fieldType) {
            return fieldType;
          }

          // For optional access, missing field returns dyn; for regular access, throw
          if (allowMissingField) {
            return this.dynType;
          }

          throw this.createError('no_such_key', `No such key: ${keyName}`, ast);
        }
      }

      return this.dynType;
    }

    // No other types support indexing/property access
    throw this.createError(
      'cannot_index_type',
      `Cannot index type '${this.formatType(leftType)}'`,
      ast,
    );
  }

  formatType(type: TypeDeclaration): string {
    if (!type.hasPlaceholderType) {
      return type.name;
    }

    const templated = templatedName(this.registry, type);

    return typeof templated === 'string' ? templated : templated.name;
  }

  formatTypeList(types: readonly TypeDeclaration[]): string {
    return types.map((t) => this.formatType(t)).join(', ');
  }
}
