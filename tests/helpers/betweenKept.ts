/** Three lines of the User's whose middle one has eight words of its own, and its Chinese twin with ten. */
export const BETWEEN_KEPT = {
  en: [
    "Council tax is 140 a month.",
    "Home insurance covers the flat and contents for 22 a month.",
    "Phone is 15 a month.",
  ],
  zh: ["物业费每月150元。", "家庭保险每月22元，包括房屋和家具。", "电话费每月15元。"],
};

/**
 * New lines a reply without names writes between the two lines around the middle one, and whether
 * each takes its place: only one that says more than half of its own words does.
 */
export const BETWEEN_KEPT_LINES = [
  { case: "en, about something else", language: "en", line: "Gym is 30 a month.", takes: false },
  {
    case: "en, its words and more",
    language: "en",
    line: "Home insurance covers the flat and contents for 22 a month, paid each January.",
    takes: true,
  },
  {
    case: "en, five of its eight words",
    language: "en",
    line: "Home insurance covers the flat, at 25 a month.",
    takes: true,
  },
  {
    case: "en, four of its eight words",
    language: "en",
    line: "Home insurance covers the car too, at 30 a month.",
    takes: false,
  },
  { case: "zh, about something else", language: "zh", line: "健身卡每月30元。", takes: false },
  {
    case: "zh, its words and more",
    language: "zh",
    line: "家庭保险每月22元，包括房屋和家具，每年一月交。",
    takes: true,
  },
  {
    case: "zh, six of its ten words",
    language: "zh",
    line: "家庭保险每月30元，包括房子和车险。",
    takes: true,
  },
  {
    case: "zh, five of its ten words",
    language: "zh",
    line: "家庭保险每月30元，包括车险和意外险。",
    takes: false,
  },
] as const;
