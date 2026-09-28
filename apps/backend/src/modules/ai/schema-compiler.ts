import { z, type ZodType, type ZodTypeDef } from 'zod';

export interface PortableJsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, any>;
  items?: any;
  required?: string[];
  additionalProperties?: boolean;
  enum?: (string | number)[];
  nullable?: boolean;
  [key: string]: any;
}

/**
 * Recursively unwraps Zod effects / refinements / defaults / optionals / nullables
 * to determine the underlying base schema type.
 */
function unwrapZodType(schema: ZodType<any, ZodTypeDef, any>): {
  baseType: any;
  isNullable: boolean;
  isOptional: boolean;
  description?: string;
} {
  let current: any = schema;
  let isNullable = false;
  let isOptional = false;
  let description = schema.description;

  while (current) {
    if (current._def?.description && !description) {
      description = current._def.description;
    }

    if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else if (current instanceof z.ZodNullable) {
      isNullable = true;
      current = current.unwrap();
    } else if (current instanceof z.ZodOptional) {
      isOptional = true;
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
    } else {
      break;
    }
  }

  return { baseType: current, isNullable, isOptional, description };
}

/**
 * Compiles a Zod schema into a portable strict JSON Schema conforming to
 * JSON Schema Draft 7 / OpenAI Strict Schema standards.
 */
export function compilePortableJsonSchema(schema: ZodType<any>): PortableJsonSchema {
  const { baseType, isNullable, description } = unwrapZodType(schema);

  if (baseType instanceof z.ZodObject) {
    const shape = baseType.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      const fieldCompiled = compilePortableJsonSchema(fieldSchema as ZodType<any>);
      properties[key] = fieldCompiled;
      // In strict mode, all defined keys must be listed in required
      required.push(key);
    }

    const result: PortableJsonSchema = {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodArray) {
    const itemSchema = compilePortableJsonSchema(baseType.element);
    const result: PortableJsonSchema = {
      type: 'array',
      items: itemSchema,
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodLiteral) {
    const val = baseType.value;
    const typeOfVal = typeof val;
    const type =
      typeOfVal === 'number' ? (Number.isInteger(val) ? 'integer' : 'number') : typeOfVal;
    const result: PortableJsonSchema = {
      type,
      enum: [val],
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodNativeEnum) {
    const values = Object.values(baseType._def.values) as (string | number)[];
    // Filter numeric enum reverse-mappings
    const filtered = values.filter((v) => typeof v === 'string' || typeof v === 'number');
    const result: PortableJsonSchema = {
      type: typeof filtered[0] === 'number' ? 'number' : 'string',
      enum: filtered,
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodEnum) {
    const result: PortableJsonSchema = {
      type: 'string',
      enum: baseType._def.values,
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodString) {
    const result: PortableJsonSchema = {
      type: 'string',
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodNumber) {
    const isInt = baseType._def.checks?.some((c: any) => c.kind === 'int');
    const result: PortableJsonSchema = {
      type: isInt ? 'integer' : 'number',
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  if (baseType instanceof z.ZodBoolean) {
    const result: PortableJsonSchema = {
      type: 'boolean',
    };
    if (description) result.description = description;
    if (isNullable) result.nullable = true;
    return result;
  }

  // Fallback for primitive or unknown types
  return {
    type: 'string',
    ...(description ? { description } : {}),
    ...(isNullable ? { nullable: true } : {}),
  };
}

/**
 * Transforms a portable JSON schema into provider-specific payload structures:
 * - OPENAI / DEEPINFRA: response_format with { type: 'json_schema', json_schema: { name, strict: true, schema } }
 *   (Strict mode: converts nullable fields to anyOf: [schema, { type: 'null' }] and removes nullable: true)
 * - GEMINI: generationConfig with responseSchema (OpenAPI type uppercase format, native nullable: true)
 * - OLLAMA: raw JSON Schema format object
 */
export function compileProviderSchema(
  provider: 'OPENAI' | 'GEMINI' | 'DEEPINFRA' | 'OLLAMA' | 'MOCK',
  schema: ZodType<any>,
  schemaName: string,
): Record<string, unknown> {
  const portable = structuredClone(compilePortableJsonSchema(schema));

  switch (provider) {
    case 'OPENAI':
    case 'DEEPINFRA': {
      // Adapt schema for OpenAI / DeepInfra strict structured outputs (JSON Schema Draft 7)
      const adaptForOpenAiStrict = (node: any): any => {
        if (!node || typeof node !== 'object') return node;

        const isNullable = Boolean(node.nullable);
        const { nullable: _ignored, ...cleanNode } = node;

        if (cleanNode.properties) {
          const newProps: Record<string, any> = {};
          for (const [k, v] of Object.entries(cleanNode.properties)) {
            newProps[k] = adaptForOpenAiStrict(v);
          }
          cleanNode.properties = newProps;
          cleanNode.additionalProperties = false;
          // In strict mode, every key defined in properties must be in required
          cleanNode.required = Object.keys(newProps);
        }

        if (cleanNode.items) {
          cleanNode.items = adaptForOpenAiStrict(cleanNode.items);
        }

        if (isNullable) {
          return {
            anyOf: [cleanNode, { type: 'null' }],
          };
        }

        return cleanNode;
      };

      return {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: adaptForOpenAiStrict(portable),
        },
      };
    }

    case 'GEMINI': {
      // Adapt schema for Gemini REST OpenAPI 3.0 requirements
      const adaptForGemini = (node: any): any => {
        if (!node || typeof node !== 'object') return node;

        const copy: Record<string, any> = {};
        if (node.type) {
          copy.type = String(node.type).toUpperCase();
        }
        if (node.description) copy.description = node.description;
        if (node.enum) copy.enum = node.enum;
        if (node.nullable) copy.nullable = true;

        if (node.properties) {
          copy.properties = {};
          for (const [k, v] of Object.entries(node.properties)) {
            copy.properties[k] = adaptForGemini(v);
          }
        }
        if (node.required && Array.isArray(node.required)) {
          // Gemini: if a field is nullable, omit from required
          const filteredRequired = node.required.filter((key: string) => {
            const prop = node.properties?.[key];
            return !prop?.nullable;
          });
          if (filteredRequired.length > 0) {
            copy.required = filteredRequired;
          }
        }
        if (node.items) {
          copy.items = adaptForGemini(node.items);
        }
        return copy;
      };

      return {
        responseMimeType: 'application/json',
        responseSchema: adaptForGemini(portable),
      };
    }

    case 'OLLAMA':
    case 'MOCK':
    default: {
      return portable as unknown as Record<string, unknown>;
    }
  }
}
