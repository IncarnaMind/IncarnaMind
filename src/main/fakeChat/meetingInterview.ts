/**
 * A smoke fixture's interview, test data shaped like a real one (#2306): one person answers four
 * questions over four topics, and the smoke model writes a fact for each answer under its topic,
 * with the overview citing the first and last answers.
 */
import { passagesIn, UNIT_MARK } from "./passages";
import { type Prompt, type Reply, toolResults } from "./prompt";

interface InterviewCall {
  questions: readonly string[];
  answers: readonly { heading: string; topic: string; said: string; written: string }[];
  overview: readonly [string, string];
}

export const INTERVIEW: Readonly<Record<"en" | "zh-CN", InterviewCall>> = {
  en: {
    questions: [
      "Could you start by introducing yourself?",
      "How did you come to start a company?",
      "What are you working on now?",
      "How do you see paid courses?",
    ],
    answers: [
      {
        heading: "Education and career",
        topic: "education",
        said: "I'm Lin Zhou. I studied computer science and then did a master's abroad.",
        written: "Lin Zhou studied computer science and then did a master's abroad.",
      },
      {
        heading: "Education and career",
        topic: "first job",
        said: "After that I spent four years on speech recognition at a research lab.",
        written: "Lin Zhou spent four years on speech recognition at a research lab.",
      },
      {
        heading: "The startup and its sale",
        topic: "founding",
        said: "In 2015 two classmates and I started a customer service chatbot company.",
        written: "In 2015 Lin Zhou and two classmates started a customer service chatbot company.",
      },
      {
        heading: "The startup and its sale",
        topic: "acquisition",
        said: "A listed company bought it in 2019, and I stayed a year to lead the team.",
        written: "A listed company bought it in 2019, and Lin Zhou stayed a year to lead the team.",
      },
      {
        heading: "The AI course and its community",
        topic: "course",
        said: "Last year I started a course on using AI at work, and it has over three thousand students.",
        written: "Lin Zhou's course on using AI at work has over three thousand students.",
      },
      {
        heading: "The AI course and its community",
        topic: "community",
        said: "The students run their own group, and every week someone shows a tool they built.",
        written:
          "The students run their own group, where someone shows a tool they built each week.",
      },
      {
        heading: "On paid courses",
        topic: "selling worry",
        said: "Too many paid courses sell worry; a course should teach people to build things.",
        written:
          "Lin Zhou thinks too many paid courses sell worry instead of teaching people to build.",
      },
      {
        heading: "On paid courses",
        topic: "lasting use",
        said: "A good course is one whose students still use what they learned three months later.",
        written: "For Lin Zhou, a good course is one students still use three months later.",
      },
    ],
    overview: [
      "Lin Zhou talked about the path from study and research to a startup that was sold",
      "the AI course he runs now and how he sees paid courses",
    ],
  },
  "zh-CN": {
    questions: [
      "先请你介绍一下自己。",
      "你是怎么开始创业的？",
      "你现在在做什么？",
      "你怎么看知识付费？",
    ],
    answers: [
      {
        heading: "教育与职业经历",
        topic: "教育背景",
        said: "我叫林舟，本科读的是计算机，后来出国读了硕士。",
        written: "林舟本科读计算机，后来出国读了硕士。",
      },
      {
        heading: "教育与职业经历",
        topic: "第一份工作",
        said: "毕业以后我在一家研究院做了四年语音识别。",
        written: "林舟毕业后在一家研究院做了四年语音识别。",
      },
      {
        heading: "创业与被收购",
        topic: "创业",
        said: "2015年我和两个同学一起创办了一家做智能客服的公司。",
        written: "2015年林舟和两个同学创办了一家做智能客服的公司。",
      },
      {
        heading: "创业与被收购",
        topic: "收购",
        said: "2019年公司被一家上市公司收购，我留下来带了一年团队。",
        written: "公司在2019年被一家上市公司收购，林舟留下来带了一年团队。",
      },
      {
        heading: "AI 课程与社群",
        topic: "课程",
        said: "去年我开了一门教大家用AI工作的课，现在有三千多名学员。",
        written: "林舟去年开了一门AI应用课，现在有三千多名学员。",
      },
      {
        heading: "AI 课程与社群",
        topic: "社群",
        said: "学员自己组了一个社群，每周都有人分享自己做的小工具。",
        written: "学员自己组了社群，每周有人分享自己做的小工具。",
      },
      {
        heading: "对知识付费的看法",
        topic: "卖焦虑",
        said: "我觉得很多知识付费是在卖焦虑，课程应该教人真的做出东西。",
        written: "林舟认为很多知识付费在卖焦虑，课程应该教人真的做出东西。",
      },
      {
        heading: "对知识付费的看法",
        topic: "长期有用",
        said: "好的课程要让学员三个月以后还在用学到的方法。",
        written: "林舟认为好课程要让学员三个月后还在用学到的方法。",
      },
    ],
    overview: [
      "林舟讲了从读书、做研究到创业并被收购的经历",
      "也谈了现在的 AI 课程和对知识付费的看法",
    ],
  },
};

/** Each line the Transcript shows, with the Passage and time it is at. */
function heardLines(asked: string) {
  const transcript = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(asked)?.[1] ?? "";
  return passagesIn(transcript).flatMap((passage) =>
    passage.text.split("\n").flatMap((line) => {
      const mark = UNIT_MARK.exec(line);
      const at = mark?.[1]?.split(" ")[0];
      return mark && at
        ? [{ passage: passage.id, at, text: line.slice(mark[0].length).trim() }]
        : [];
    }),
  );
}

/** The interview's facts and overview, once its answers are cited; null for any other call. */
export function interviewReply(
  asked: string,
  prompt: Prompt,
  tools: readonly string[],
): Reply | null {
  const heard = heardLines(asked);
  const call = Object.values(INTERVIEW).find((each) =>
    heard.some((line) => line.text === each.answers[0]?.said),
  );
  if (!call) return null;
  const answered = call.answers.flatMap((answer) => {
    const line = heard.find((each) => each.text === answer.said);
    return line ? [{ ...answer, line }] : [];
  });
  if (tools.includes("cite") && toolResults(prompt, "cite").length === 0) {
    return {
      tool: "cite",
      input: {
        citations: answered.map(({ line }, index) => ({
          marker: index + 1,
          passage: line.passage,
          location: line.at,
          quote: line.text,
        })),
      },
    };
  }
  const id = /Use new ids (P\d+_F)1/.exec(asked)?.[1] ?? "P1_F";
  const chinese = call === INTERVIEW["zh-CN"];
  const stop = chinese ? "。" : ".";
  const facts = answered.flatMap((answer, index) => [
    `### FACT ${id}${index + 1}`,
    "```json",
    JSON.stringify({
      topic: answer.topic,
      heading: answer.heading,
      citations: [index + 1],
      lines: [],
      sections: ["summary"],
      claim: true,
      supersedes: [],
    }),
    "```",
    `${answer.written.replace(/[.。]$/u, "")} [^${index + 1}]${stop}`,
    `### END ${id}${index + 1}`,
  ]);
  const [about, came] = call.overview;
  return {
    text: [
      ...facts,
      "### OVERVIEW",
      "```json",
      JSON.stringify({ citations: [1, answered.length] }),
      "```",
      `${about} [^1]${chinese ? "，" : ", and "}${came} [^${answered.length}]${stop}`,
      "### END OVERVIEW",
    ].join("\n\n"),
  };
}
