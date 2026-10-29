import type { JSONSchema7 } from "ai";

type Definition = NonNullable<JSONSchema7["properties"]>[string];

/**
 * A reply schema in the form OpenAI's strict structured output takes, which
 * the other APIs that enforce a schema accept too: every object closed
 * (`additionalProperties: false`) and every property listed in `required`.
 * A property the schema left optional becomes nullable instead, so a reply
 * holds null where it had no value. Throws for what that form cannot say: an
 * object with no properties, or with free-form ones.
 */
export function strictSchema(schema: JSONSchema7): JSONSchema7 {
  if (schema.type !== "object") throw new Error("A reply schema must be an object at its root.");
  return closed(schema, "#");
}

function asSchema(definition: Definition, at: string): JSONSchema7 {
  if (typeof definition === "boolean") throw new Error(`${at} is a bare ${definition}.`);
  return definition;
}

function closed(schema: JSONSchema7, at: string): JSONSchema7 {
  const next: JSONSchema7 = { ...schema };
  if (schema.anyOf) {
    next.anyOf = schema.anyOf.map((each: Definition, index: number) =>
      closed(asSchema(each, `${at}/anyOf/${index}`), `${at}/anyOf/${index}`),
    );
  }
  if (schema.items !== undefined && !Array.isArray(schema.items)) {
    next.items = closed(asSchema(schema.items, `${at}/items`), `${at}/items`);
  }
  if (schema.type !== "object" && schema.properties === undefined) return next;
  const { properties } = schema;
  if (properties === undefined) throw new Error(`${at} is an object with no properties.`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`${at} is an object with free-form properties.`);
  }
  const required = new Set(schema.required);
  next.properties = Object.fromEntries(
    Object.entries(properties).map(([name, definition]) => {
      const property = closed(asSchema(definition, `${at}/${name}`), `${at}/${name}`);
      return [name, required.has(name) ? property : orNull(property)];
    }),
  );
  next.required = Object.keys(properties);
  next.additionalProperties = false;
  return next;
}

/** Strict mode takes `["string", "null"]` for a plain value, and a union with null for an object or array. */
function orNull(schema: JSONSchema7): JSONSchema7 {
  const { type } = schema;
  if (schema.anyOf || type === undefined || type === "object" || type === "array") {
    return { anyOf: [schema, { type: "null" }] };
  }
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("null")) return schema;
  return {
    ...schema,
    type: [...types, "null"],
    ...(schema.enum && { enum: [...schema.enum, null] }),
  };
}
