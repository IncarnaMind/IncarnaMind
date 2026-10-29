export const calculationsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      marker: {
        type: "integer",
        description:
          "The figure's marker number: 1 for [=1]. Figures are numbered apart from Citations.",
      },
      label: {
        type: "string",
        description: 'What the result is, with its period: "Revenue growth 2025".',
      },
      inputs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A short name for the formula: rev2024." },
            label: {
              type: "string",
              description: 'What it is, with its year or period: "Revenue 2024".',
            },
            citation: {
              type: "integer",
              description:
                "The marker of a Citation record with the number in its quote: 1 for [^1]. Or give passage, location and quote instead.",
            },
            passage: {
              type: "string",
              description: "Instead of citation: the Passage's id, e.g. P1.",
            },
            location: {
              type: "string",
              description: "With passage: where the quote is, as for a Citation.",
            },
            quote: {
              type: "string",
              description: "With passage: a short quote holding the number, copied word for word.",
            },
            number: {
              type: "string",
              description: 'The number as it is written in the quote: "1.2亿", "$1,482.6 million".',
            },
            position: {
              type: "integer",
              description:
                "Instead of number, when the number is in the quote twice: its place among the quote's numbers, 1 for the first.",
            },
            unitQuote: {
              type: "string",
              description:
                'When the number\'s scale or currency is only in a table\'s heading or caption ("单位：万元", "in millions"): that line, copied word for word from the same Passage.',
            },
            reading: {
              type: "integer",
              description:
                "Only when told the number can be read more than one way: the reading to use, as numbered then.",
            },
            rate: {
              type: "string",
              description:
                'Only for an exchange rate: the currencies it converts, as "CNY per USD".',
            },
          },
          required: ["name"],
        },
      },
      formula: {
        type: "string",
        description:
          "Available functions: SUM, AVERAGE, MIN, MAX, ABS, SIGN, ROUND, RRI, SQRT. In Excel's syntax, over the inputs' names: (rev2025 - rev2024) / rev2024, SUM(q1, q2, q3, q4), RRI(4, start, end), a > b. A percent is a share, 25% is 0.25: never multiply by 100, give as instead. Inputs are in base units: never multiply or divide by 1000 or 10000 to change the scale, give scale instead.",
      },
      as: {
        type: "string",
        enum: ["number", "percent", "points", "currency", "times", "yes-no"],
        description:
          "How to show the result: percent for a growth rate or a share. Default: from the inputs.",
      },
      decimals: { type: "integer", description: "Decimal places, when the default won't do." },
      scale: {
        type: "string",
        description:
          "Show an amount in this scale: 万, 亿, thousand, million, billion. Inputs are in base units with their page's scale applied, so this, never the formula, sets the scale shown.",
      },
    },
    required: ["marker", "inputs", "formula"],
  },
} as const;

/**
 * In a check Run (#707), each figure also names the number of the sentence it
 * is for, which IncarnaMind compares the result with.
 */
export const checkCalculationsSchema = {
  ...calculationsSchema,
  items: {
    ...calculationsSchema.items,
    properties: {
      ...calculationsSchema.items.properties,
      inputs: {
        ...calculationsSchema.items.properties.inputs,
        items: {
          ...calculationsSchema.items.properties.inputs.items,
          properties: {
            ...calculationsSchema.items.properties.inputs.items.properties,
            bracketedCost: {
              type: "boolean",
              description:
                'True when the number is a cost or deduction printed in brackets ("Finance costs (41.2)", "财务费用 (41.2)"), so its size is meant. Never for a loss or another result in brackets.',
            },
          },
        },
      },
      stated: {
        type: "string",
        description:
          'The exact quantity copied from the sentence to check, in its original language: "1.1x", "12%", "three", "三年". Never translate it or replace written words with digits.',
      },
      relation: {
        type: "string",
        enum: ["equals", "at most", "at least"],
        description:
          'How the figure stands to stated: "equals" when stated is the figure; "at most" or "at least" when stated is a limit the sentence says the figure stays within or above ("inside a 3.25x covenant", "不超过3.25倍", "至少5倍").',
      },
    },
    required: [...calculationsSchema.items.required, "stated", "relation"],
  },
} as const;
