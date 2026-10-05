export type StructuredOutputContractFailure =
  | 'unsupported-schema'
  | 'missing-tool-call'
  | 'multiple-tool-calls'
  | 'unexpected-tool-call'
  | 'invalid-tool-arguments'
  | 'schema-validation';

/**
 * A public, non-secret failure at the structured-output boundary. The
 * violations contain JSON paths and contract messages only; they never include
 * prompt text, evidence, credentials, or provider headers.
 */
export class StructuredOutputContractError extends Error {
  readonly code = 'AI_STRUCTURED_OUTPUT_CONTRACT';
  readonly reason: StructuredOutputContractFailure;
  readonly violations: readonly string[];

  constructor(
    reason: StructuredOutputContractFailure,
    message: string,
    options: { violations?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StructuredOutputContractError';
    this.reason = reason;
    this.violations = Object.freeze([...(options.violations ?? [])]);
  }
}

export function isStructuredOutputContractError(error: unknown): error is StructuredOutputContractError {
  return error instanceof StructuredOutputContractError;
}

const supportedKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf',
  'enum',
  'const',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'description',
  'title',
  'default',
  'examples',
]);

const supportedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Rejects schemas containing constraints this local validator cannot enforce. */
export function assertSupportedStructuredOutputSchema(schema: unknown): asserts schema is Record<string, unknown> {
  const violations: string[] = [];
  inspectSchemaNode(schema, '$schema', violations, new Set());
  if (violations.length > 0) {
    throw new StructuredOutputContractError(
      'unsupported-schema',
      `结构化输出 Schema 包含 ${violations.length} 个不受支持的约束。`,
      { violations },
    );
  }
}

/** Returns path-qualified validation failures. An empty array means accepted. */
export function validateStructuredOutputValue(
  schema: Record<string, unknown>,
  value: unknown,
  path = '$',
): string[] {
  const violations: string[] = [];
  validateNode(schema, value, path, violations);
  return violations;
}

export function assertValidStructuredOutputValue(schema: Record<string, unknown>, value: unknown): void {
  const violations = validateStructuredOutputValue(schema, value);
  if (violations.length > 0) {
    throw new StructuredOutputContractError(
      'schema-validation',
      `模型结构化输出未通过 Schema 校验（${violations.length} 项）。`,
      { violations },
    );
  }
}

function inspectSchemaNode(
  schema: unknown,
  path: string,
  violations: string[],
  ancestors: Set<object>,
): void {
  if (!isPlainRecord(schema)) {
    violations.push(`${path} 必须是普通 JSON 对象`);
    return;
  }
  if (ancestors.has(schema)) {
    violations.push(`${path} 不允许循环引用`);
    return;
  }
  const nextAncestors = new Set(ancestors).add(schema);
  for (const key of Object.keys(schema)) {
    if (!supportedKeywords.has(key)) violations.push(`${path}.${key} 不受支持`);
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (types.some((type) => typeof type !== 'string' || !supportedTypes.has(type))) {
    violations.push(`${path}.type 包含不受支持的类型`);
  }
  if (schema.required !== undefined
    && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
    violations.push(`${path}.required 必须是字符串数组`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties 目前只支持布尔值`);
  }
  if (schema.properties !== undefined) {
    if (!isPlainRecord(schema.properties)) violations.push(`${path}.properties 必须是对象`);
    else {
      for (const [key, child] of Object.entries(schema.properties)) {
        inspectSchemaNode(child, `${path}.properties.${key}`, violations, nextAncestors);
      }
    }
  }
  if (schema.items !== undefined) inspectSchemaNode(schema.items, `${path}.items`, violations, nextAncestors);
  inspectSchemaBranches(schema.anyOf, `${path}.anyOf`, violations, nextAncestors);
  inspectSchemaBranches(schema.oneOf, `${path}.oneOf`, violations, nextAncestors);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) violations.push(`${path}.enum 必须是数组`);
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
      violations.push(`${path}.${key} 必须是非负整数`);
    }
  }
  for (const key of ['minimum', 'maximum'] as const) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      violations.push(`${path}.${key} 必须是有限数字`);
    }
  }
}

function inspectSchemaBranches(
  value: unknown,
  path: string,
  violations: string[],
  ancestors: Set<object>,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${path} 必须是非空数组`);
    return;
  }
  value.forEach((child, index) => inspectSchemaNode(child, `${path}[${index}]`, violations, ancestors));
}

function validateNode(schema: Record<string, unknown>, value: unknown, path: string, violations: string[]): void {
  if (Array.isArray(schema.anyOf)) {
    const branchViolations = schema.anyOf.map((branch) => {
      const current: string[] = [];
      if (isPlainRecord(branch)) validateNode(branch, value, path, current);
      else current.push(`${path} 的 anyOf 分支无效`);
      return current;
    });
    if (!branchViolations.some((current) => current.length === 0)) {
      const closest = [...branchViolations].sort((left, right) => left.length - right.length)[0] ?? [];
      violations.push(`${path} 不符合任何 anyOf 分支`, ...closest.slice(0, 3));
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      if (!isPlainRecord(branch)) return false;
      const current: string[] = [];
      validateNode(branch, value, path, current);
      return current.length === 0;
    }).length;
    if (matches !== 1) violations.push(`${path} 必须且只能符合一个 oneOf 分支（实际 ${matches} 个）`);
  }

  if (Object.hasOwn(schema, 'const') && !jsonEquals(value, schema.const)) {
    violations.push(`${path} 必须等于 ${formatJsonValue(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEquals(value, candidate))) {
    violations.push(`${path} 不在允许的枚举值中`);
  }

  const types = Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : typeof schema.type === 'string' ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    violations.push(`${path} 类型必须为 ${types.join('|')}`);
    return;
  }

  if (types.includes('object') || schema.properties !== undefined || schema.required !== undefined) {
    validateObject(schema, value, path, violations);
  }
  if (types.includes('array') || schema.items !== undefined) validateArray(schema, value, path, violations);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && Array.from(value).length < schema.minLength) violations.push(`${path} 长度小于 ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && Array.from(value).length > schema.maxLength) violations.push(`${path} 长度超过 ${schema.maxLength}`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) violations.push(`${path} 小于最小值 ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) violations.push(`${path} 超过最大值 ${schema.maximum}`);
  }
}

function validateObject(schema: Record<string, unknown>, value: unknown, path: string, violations: string[]): void {
  if (!isPlainRecord(value)) return;
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) violations.push(`${propertyPath(path, key)} 为必填字段`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) violations.push(`${propertyPath(path, key)} 是不允许的额外字段`);
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key) && isPlainRecord(childSchema)) {
      validateNode(childSchema, value[key], propertyPath(path, key), violations);
    }
  }
}

function validateArray(schema: Record<string, unknown>, value: unknown, path: string, violations: string[]): void {
  if (!Array.isArray(value)) return;
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) violations.push(`${path} 数量小于 ${schema.minItems}`);
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) violations.push(`${path} 数量超过 ${schema.maxItems}`);
  if (isPlainRecord(schema.items)) {
    value.forEach((item, index) => validateNode(schema.items as Record<string, unknown>, item, `${path}[${index}]`, violations));
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isPlainRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
