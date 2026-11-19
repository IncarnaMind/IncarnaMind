/**
 * What `calculate` takes (#3393): each figure's inputs as plain numbers with the quotes they come
 * from, a formula over their names, and the figure's label, which says what it is. The result goes
 * back to the model, which writes the figure in its text.
 */
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
        description: 'What the figure is, with its period and unit: "Revenue growth 2025 (%)".',
      },
      inputs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A short name for the formula: rev2024." },
            label: {
              type: "string",
              description: 'What it is, with its year or period and unit: "Revenue 2024 ($)".',
            },
            value: {
              type: "number",
              description:
                "The number you use, as a plain number: the quote's own digits, moved by a power of ten only where you mean another scale or unit (2.7亿 as 270000000, 45 cents as 0.45 dollars, 6% as 0.06).",
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
              description:
                "Only when the quote has the same digits twice: the number as the quote writes it.",
            },
          },
          required: ["name", "value"],
        },
      },
      formula: {
        type: "string",
        description:
          "Available functions: SUM, AVERAGE, MIN, MAX, ABS, SIGN, ROUND, RRI, SQRT. In Excel's syntax, over the inputs' names: (rev2025 - rev2024) / rev2024, SUM(q1, q2, q3, q4), RRI(4, start, end), a > b.",
      },
      constants: {
        type: "array",
        items: { type: "string" },
        description:
          "Only when calculate's reply asks for it: the numbers written in the formula that are constants of the arithmetic itself, such as 12 months in a year.",
      },
    },
    required: ["marker", "label", "inputs", "formula"],
  },
} as const;
