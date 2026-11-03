/**
 * The four sample papers in `data/`: made for this repository, each in a
 * fictional research organisation's voice, with the sentences the sample test
 * and the evaluations quote kept on the pages they cite (data/README.md).
 */
import { at, type SamplePage } from "./layout";

/** Repeats a paragraph pool over the pages between two others. */
function prose(
  pool: readonly string[],
  headings: readonly string[],
  perPage: number,
): string[][] {
  return headings.map((_, page) =>
    Array.from({ length: perPage }, (_, index) => at(pool, page * perPage + index)),
  );
}

const ATTENTION_POOL = [
  "Recurrence ties each step of a computation to the one before it, which is why a recurrent model cannot be spread across accelerators as freely as a feed-forward one.",
  "A weight for a value comes from comparing a query against that value's key; the answer is the weighted sum of the values. Nothing in that operation depends on the order in which positions are read.",
  "Three designs are compared here: a recurrent baseline, a convolutional baseline, and one that uses only attention. Data, tokeniser and schedule are identical across them.",
  "Quality is reported as BLEU on held-out halves of the Halden corpus, and cost as accelerator hours on the machine described in Section 3.",
  "The shape is the usual encoder-decoder one: a source sentence goes in, a target sentence comes out, and both sides repeat the same block.",
  "A block carries two sub-layers — a weighted-key layer and a position-wise feed-forward layer — each with a residual path and a normalisation step around it.",
  "Nothing in the block tells it where a token sits, so a position signal is added to the embeddings before the first layer.",
  "On the decoder side the weighting is masked: a slot may look only at slots already produced, never ahead at the target it should be predicting.",
  "Several weightings in parallel let a layer consult different subspaces at once; one weighting would have to average them into a single view.",
  "The feed-forward part is a pair of linear maps with a rectified unit between them, applied to each slot independently.",
  "Embeddings are shared between the source side, the target side and the output projection, and are scaled by the square root of the width.",
  "An inverse-square-root decay follows a linear ramp at the start of training, which kept the early updates from overshooting in our runs.",
  "Dropout is applied after each sub-layer, before the residual sum, and again to the combined embedding and position signal.",
  "At test time a beam of five is used, and the last four saved checkpoints are averaged into one model.",
  "Attention on its own was enough to pass the recurrent baselines on both translation directions, at a lower training cost.",
  "The sweep over head counts and head widths holds the layer width fixed, so that only the split changes.",
  "A few heads were inspected by hand. Their weightings follow plausible syntactic groupings, though we stop short of claiming a role for every head.",
  "Loss falls more smoothly than in the recurrent baseline, and fewer steps are needed to reach a given score; a shorter route between positions is our explanation.",
  "Learned position embeddings were tried alongside the fixed ones and gave about the same quality, so the fixed version is reported.",
  "The cost of a layer grows with the square of the sequence length, which is a real limit for very long inputs and is left to later work.",
  "Configuration files and the training scripts accompany this report so that the runs can be repeated on the same corpus.",
  "Layer count was varied from three to nine per stack. Quality improved up to seven and changed little beyond it, while training time kept growing.",
  "Removing the residual paths makes deep stacks unstable, which supports the reading that those paths carry the gradient down the stack.",
  "Outputs that differ most from the reference translations are listed in the appendix, with the model's own tokenisation beside each.",
];

export const ATTENTION: SamplePage[] = [
  {
    title: ["Weighted Keys, Shorter Paths"],
    titleSize: 26,
    subtitle: [
      "A translation model without recurrence",
      "A report from the Calventis Institute for Machine Intelligence",
    ],
    heading: "Summary",
    paragraphs: [
      "Translation systems usually carry information along a sequence one step at a time. The network described here does not: the Calventis model is assembled entirely from weighted-key lookups, with no recurrent or convolutional part anywhere in it.",
      "On two directions of the Halden corpus it beat the recurrent systems we trained, and it was cheaper to run in parallel. The largest configuration trained for 4.5 days on twelve accelerator cards.",
    ],
    anchors: [
      "The network described here does not: the Calventis model is assembled entirely from weighted-key lookups, with no recurrent or convolutional part anywhere in it.",
      "The largest configuration trained for 4.5 days on twelve accelerator cards.",
    ],
    small: ["Prepared for software testing. The text is fictional."],
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "1 Why leave recurrence behind",
    paragraphs: [
      at(ATTENTION_POOL, 0),
      at(ATTENTION_POOL, 1),
      "This report makes the case that a sequence model does not need a recurrent path, and describes one whose whole computation is a stack of weighted-key lookups.",
      "The result is shorter to implement and cheaper to parallelise, and on the tests below it needs fewer operations than the recurrent baselines to reach the same quality.",
    ],
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "2 The block",
    paragraphs: [
      at(ATTENTION_POOL, 4),
      "Each stack holds seven identical blocks.",
      at(ATTENTION_POOL, 5),
      "A residual connection [1] wraps each sub-layer, and layer normalisation [2] follows it.",
      "Both the encoder and the decoder are built from self-attention and position-wise feed-forward layers.",
      "The decoder adds a third sub-layer, so that its masked lookup can consult what the encoder produced.",
      "Masking, plus the one-position shift on the output side, keeps each prediction to positions already produced.",
    ],
    anchors: [
      "Each stack holds seven identical blocks.",
      "A residual connection [1] wraps each sub-layer, and layer normalisation [2] follows it.",
      "Both the encoder and the decoder are built from self-attention and position-wise feed-forward layers.",
      "Masking, plus the one-position shift on the output side, keeps each prediction to positions already produced.",
    ],
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "2.1 One lookup or several",
    paragraphs: [
      at(ATTENTION_POOL, 8),
      at(ATTENTION_POOL, 7),
      "Two ways of drawing on a sequence are compared in Table 1: the step-by-step route and the all-pairs route.",
    ],
    table: {
      caption: "Table 1: Work per layer for three ways of drawing on a sequence, by sequence length n and width d.",
      columns: ["Layer type", "Operations", "Sequential steps", "Path length"],
      rows: [
        ["Recurrent", "O(n d2)", "O(n)", "O(n)"],
        ["Convolutional", "O(k n d2)", "O(1)", "O(log n)"],
        ["Weighted keys", "O(n2 d)", "O(1)", "O(1)"],
        ["Local windowed keys", "O(r n d)", "O(1)", "O(n / r)"],
      ],
      weights: [2.2, 2, 2, 2],
      bands: [2],
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "2.2 Several heads at once",
    paragraphs: [
      at(ATTENTION_POOL, 8),
      "The base model runs twelve attention heads in each layer.",
      "Each head works at a fraction of the full width, which keeps the layer's cost close to that of one wide head.",
      at(ATTENTION_POOL, 15),
    ],
    anchors: ["The base model runs twelve attention heads in each layer."],
    chart: {
      bars: [
        { label: "1 head", value: 32.1 },
        { label: "6 heads", value: 33.9 },
        { label: "12 heads", value: 34.6 },
        { label: "24 heads", value: 34.2 },
      ],
      note: "BLEU on the held-out German-English half, by head count, at a fixed layer width.",
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "3 Telling positions apart",
    paragraphs: [
      at(ATTENTION_POOL, 6),
      "Each position is encoded with sinusoids of geometrically spaced frequencies.",
      "Because the frequencies are fixed rather than learned, a linear map can compare two positions by the ratio between their encodings.",
      "Fixed sinusoids were kept because they may carry over to sequences longer than those in training.",
      "Learned position embeddings were tried as well and gave about the same quality, which is why the fixed version is the one reported.",
    ],
    anchors: [
      "Each position is encoded with sinusoids of geometrically spaced frequencies.",
      "Fixed sinusoids were kept because they may carry over to sequences longer than those in training.",
    ],
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "3.1 Data, batching and hardware",
    paragraphs: [
      "Two directions of the Halden corpus were used: 5.8 million sentence pairs one way and 31 million the other.",
      "A shared byte-pair vocabulary encoded both sides, and batches were built by approximate length so that each held a similar number of tokens.",
      "All runs used a single machine holding twelve accelerator cards.",
      "The optimiser was Adam, with a linear ramp at the start; we set warmup_steps = 6000.",
      "Attention can also make a model easier to interpret, which is a useful side effect.",
    ],
    anchors: [
      "All runs used a single machine holding twelve accelerator cards.",
      "we set warmup_steps = 6000",
      "Attention can also make a model easier to interpret, which is a useful side effect.",
    ],
    table: {
      caption: "Table 2: The two configurations reported in this paper.",
      columns: ["Setting", "Base", "Large"],
      rows: [
        ["Blocks per stack", "7", "7"],
        ["Width", "640", "1024"],
        ["Heads", "12", "16"],
        ["Feed-forward width", "2560", "4096"],
        ["Dropout", "0.12", "0.3"],
        ["Training steps", "90,000", "280,000"],
      ],
      weights: [3, 1.5, 1.5],
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "4.1 Translation quality",
    paragraphs: [
      "On the German-English half of the held-out set the large configuration came out ahead of every system we compared with, reaching 34.6 BLEU.",
      "That is three points above the strongest baseline and was obtained at a small fraction of its training cost.",
      "Label smoothing of ε = 0.04 [3] was applied throughout. It costs perplexity, since the model is less sure of itself, but it gains accuracy and BLEU.",
      "On French-English the same configuration reached 37.9 BLEU, and it trained in a quarter of the time our previous best model needed.",
    ],
    anchors: [
      "reaching 34.6 BLEU",
      "Label smoothing of ε = 0.04 [3] was applied throughout. It costs perplexity, since the model is less sure of itself, but it gains accuracy and BLEU.",
    ],
    table: {
      caption: "Table 3: BLEU on the held-out set, with training cost.",
      columns: ["System", "German-English", "French-English", "Training cost"],
      rows: [
        ["Recurrent baseline", "29.4", "32.8", "High"],
        ["Convolutional baseline", "30.1", "33.5", "Medium"],
        ["Calventis, base", "31.8", "35.2", "Low"],
        ["Calventis, large", "34.6", "37.9", "Low"],
      ],
      weights: [2.4, 1.6, 1.6, 1.6],
      bands: [3],
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "4.2 What carries the gain",
    paragraphs: [
      "Head count, head width and the width of the feed-forward part were varied one at a time on the development half.",
      at(ATTENTION_POOL, 15),
      "With one head, the score falls by 2.5 BLEU against the best setting.",
      "Cutting the feed-forward width hurts more than cutting the attention width, so much of the capacity seems to sit in the position-wise part.",
    ],
    anchors: ["With one head, the score falls by 2.5 BLEU against the best setting."],
    chart: {
      bars: [
        { label: "Base", value: 31.8 },
        { label: "1 head", value: 32.1 },
        { label: "6 heads", value: 33.9 },
        { label: "32 heads", value: 33.6 },
      ],
      note: "BLEU on the held-out set as head count varies, wide and narrow settings mixed.",
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "5.1 A second task",
    paragraphs: [
      "A four-block model was trained on a public treebank to see whether the design transfers, and scored on the standard splits.",
      "The model does remarkably well here even though nothing was tuned for parsing, landing close to the best published numbers on the benchmark.",
      at(ATTENTION_POOL, 16),
    ],
    anchors: ["The model does remarkably well here even though nothing was tuned for parsing"],
    table: {
      caption: "Table 4: Parsing accuracy on the held-out split.",
      columns: ["System", "Training", "Accuracy"],
      rows: [
        ["Recurrent baseline", "Supervised", "90.4"],
        ["Convolutional baseline", "Supervised", "91.0"],
        ["Calventis, 4 blocks", "Supervised", "91.1"],
        ["Calventis, 4 blocks, extra data", "Semi-supervised", "92.3"],
      ],
      weights: [3, 1.6, 1.4],
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "6 Closing remarks",
    paragraphs: [
      "The Calventis model is a sequence transducer with no recurrent layers at all: weighted-key lookups do the work that recurrence used to do.",
      "On translation it trains faster than recurrent or convolutional systems and scores higher, on the two directions measured here.",
      "Later work could take the design to other input and output kinds, and to local or windowed lookups for very long inputs.",
    ],
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "References",
    paragraphs: [
      "[1] A. Author, B. Author, C. Author and D. Author. Residual learning for image recognition. In Proceedings of the Conference on Computer Vision, 2016.",
      "[2] L. Ba, J. Kiros and G. Hinton. Normalising layer inputs. A technical report, 2016.",
      "[3] A. Author, B. Author, C. Author, D. Author and E. Author. Reconsidering the inception architecture. In Proceedings of the Conference on Computer Vision, 2016.",
      "[4] A. Author and B. Author. Training sequence models on accelerator hardware. A technical report, 2017.",
      "[5] A. Author. Reading weighting patterns in translation models. A technical report, 2018.",
    ],
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "Appendix A: Weighting patterns",
    paragraphs: [
      "The tables below record average weights for three heads on one sentence pair; rows are query positions and columns key positions, and a darker cell means more weight.",
      "One head mostly looks at the slot just before, another at the verb of the clause, and a third at the final slot. The picture held for every sentence length we tried.",
    ],
    table: {
      caption: "Table 5: Mean weight by relative offset, three heads of the base model.",
      columns: ["Head", "Offset -2", "Offset -1", "Offset 0", "Offset +1"],
      rows: [
        ["Head 2", "0.07", "0.38", "0.16", "0.06"],
        ["Head 5", "0.11", "0.08", "0.24", "0.29"],
        ["Head 9", "0.05", "0.06", "0.13", "0.09"],
      ],
      weights: [1.2, 1.2, 1.2, 1.2, 1.2],
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "Appendix B: Loss curves",
    paragraphs: [
      "Development loss against training steps is plotted below for the base model and for the recurrent baseline, at one batch size and on one dataset.",
      at(ATTENTION_POOL, 17),
    ],
    chart: {
      bars: [
        { label: "10k", value: 4.1 },
        { label: "20k", value: 3.4 },
        { label: "40k", value: 2.9 },
        { label: "80k", value: 2.6 },
      ],
      note: "Development loss of the base model against training steps, in thousands.",
    },
  },
  {
    running: "Weighted Keys, Shorter Paths",
    heading: "Appendix C: Settings",
    paragraphs: [
      "The table records both configurations so that the runs can be repeated on the same data.",
      "The large model used more dropout and a longer ramp than the base model, because a wider stack made the first updates less stable.",
    ],
    table: {
      caption: "Table 6: Settings of the two configurations.",
      columns: ["Setting", "Base", "Large"],
      rows: [
        ["Learning-rate decay", "Inverse square root", "Inverse square root"],
        ["Ramp steps", "6,000", "6,000"],
        ["Dropout", "0.12", "0.3"],
        ["Label smoothing", "0.04", "0.04"],
        ["Beam", "5", "5"],
        ["Checkpoints averaged", "4", "4"],
      ],
      weights: [2.6, 1.6, 1.6],
    },
  },
];

const GRADIENT_POOL = [
  "People who train models spend a lot of time on the optimiser's own settings: a step size, a momentum term, decay rates. These are usually picked by hand or by a sweep.",
  "The idea here is to differentiate the loss with respect to those settings, so that they can be learned in the same loop as the weights.",
  "Nothing in the model's definition needs to change. What is needed is the update's computation graph, kept long enough for derivatives to pass through it.",
  "The added cost is modest: on our benchmarks the learned optimiser ran a few percent slower than the fixed one and removed the need for a sweep.",
  "Three workloads were used: a dense network on digit images, a convolutional network on colour images, and a recurrent network on character text.",
  "Splits and base optimiser are the same in every run; the only difference is whether the settings are held fixed or learned.",
  "For the recurrent workload the metric is held-out perplexity, and for the other two it is test error.",
  "Against a grid search with the same budget, the learned optimiser matched or beat the best fixed setting while using fewer runs.",
  "The same idea stacks: one optimiser tunes another, which tunes the model, and so on to any height.",
  "A tall stack is awkward to set by hand, since every level carries its own step size, but it is more forgiving once the levels are started sensibly.",
  "Each level starts below the level beneath it, so that changes at the top happen more slowly than changes at the bottom.",
  "The implementation wraps an existing optimiser and keeps its interface, so switching from a fixed one to a learned one is a one-line change.",
  "Memory grows with the height of the stack, because the update graph must be retained; the growth is linear in height and small next to the model's activations.",
  "Learned step sizes settle into a recognisable pattern: a quick fall early on, then a plateau, much like a hand-designed decay.",
  "Architecture, batch size and regularisation are still choices a person must make; what the method removes is the sweep over the optimiser's numbers.",
  "Starting step sizes spanning several orders of magnitude, in both directions from a hand-picked value, were tried to see how the stack copes.",
  "The approach looks practical where a sweep would be costly: very large models, long runs, and settings whose best rate shifts as training proceeds.",
  "A small library accompanies this report, with wrappers for the three workloads above and the scripts behind each figure.",
  "One drawback is a slower start: for the first few hundred steps the top-level rates are large and the estimates noisy.",
  "Another is the assumption that the update is differentiable in its settings, which holds for the optimisers tested here but not for all adaptive methods.",
  "Reinforcement learning was not tried. With noisy objectives and asynchronous updates, we expect the method would need more care.",
  "Every point in the figures is the mean of three seeds, and the band is one standard deviation across them.",
];

export const GRADIENT: SamplePage[] = [
  {
    title: ["Tuning the Tuner"],
    titleSize: 26,
    subtitle: [
      "Learning an optimiser's hyperparameters by backpropagation",
      "A report from the Torvane Laboratory for Optimisation Research",
    ],
    heading: "Summary",
    paragraphs: [
      "Every gradient-based training run carries settings that somebody has to choose, such as a step size. This report shows that those settings can be differentiated through the update itself and learned along with the weights.",
      "The same trick applies to the settings of the settings, so stacks of any height can be built and trained together.",
      "On dense, convolutional and recurrent workloads the learned optimiser matched a hand-tuned one and needed far fewer sweeps to get there.",
    ],
    small: ["Prepared for software testing. The text is fictional."],
  },
  {
    running: "Tuning the Tuner",
    heading: "1 Starting point",
    paragraphs: [
      at(GRADIENT_POOL, 0),
      at(GRADIENT_POOL, 1),
      "On all three architectures we tried — dense, convolutional and recurrent — the learned optimiser remained stable when its starting hyperparameters were badly chosen, and it became more stable as the stack of optimisers grew.",
    ],
    anchors: [
      "On all three architectures we tried — dense, convolutional and recurrent — the learned optimiser remained stable when its starting hyperparameters were badly chosen, and it became more stable as the stack of optimisers grew.",
    ],
  },
  {
    running: "Tuning the Tuner",
    heading: "2 The method",
    paragraphs: [
      "Take an update at step t that depends on a setting such as the step size. If that update is written into the graph, the derivative of a later loss with respect to the setting comes out of the same backward pass that supplies the weights' gradients.",
      "Keeping every step's graph would be far too expensive, so after each update the weights are cut loose from the step before. Were the update graph kept whole, backpropagation's linear cost would turn the run quadratic and make it impractical.",
      at(GRADIENT_POOL, 2),
    ],
    anchors: [
      "Were the update graph kept whole, backpropagation's linear cost would turn the run quadratic and make it impractical.",
    ],
  },
  {
    running: "Tuning the Tuner",
    heading: "2.1 Wrapping an existing optimiser",
    paragraphs: [
      at(GRADIENT_POOL, 11),
      at(GRADIENT_POOL, 12),
      at(GRADIENT_POOL, 13),
    ],
    table: {
      caption: "Table 1: Optimisers wrapped, and the settings each exposes.",
      columns: ["Optimiser", "Learned settings", "Extra memory"],
      rows: [
        ["Plain descent", "Step size", "Small"],
        ["Momentum", "Step size, momentum", "Small"],
        ["Adam", "Step size, decay rates", "Moderate"],
        ["RMSProp", "Step size, decay rate", "Moderate"],
        ["AMSGrad", "Step size, decay rates", "Moderate"],
      ],
      weights: [2, 3, 2],
    },
  },
  {
    running: "Tuning the Tuner",
    heading: "3 Workloads",
    paragraphs: [
      "The first workload is a one-hidden-layer dense network on digit images, the second a small convolutional network on colour images, and the third a recurrent network on character text.",
      at(GRADIENT_POOL, 5),
      "The experiments in this section each used one GX-7 card.",
      "Every workload compares a fixed step size from a sweep with one learned by the method, at the same number of epochs.",
    ],
    anchors: ["The experiments in this section each used one GX-7 card."],
    table: {
      caption: "Table 2: The three workloads and their base optimiser.",
      columns: ["Workload", "Data", "Metric", "Base optimiser"],
      rows: [
        ["Dense", "Digit images", "Error rate", "Adam"],
        ["Convolutional", "Colour images", "Error rate", "Adam"],
        ["Recurrent", "Character text", "Perplexity", "Adam"],
      ],
      weights: [2, 2, 1.6, 1.8],
    },
  },
  {
    running: "Tuning the Tuner",
    heading: "3.1 What the learned rate buys",
    paragraphs: [
      at(GRADIENT_POOL, 6),
      at(GRADIENT_POOL, 7),
    ],
    chart: {
      bars: [
        { label: "Fixed", value: 4.79 },
        { label: "Learned", value: 4.83 },
        { label: "Too high", value: 5.12 },
        { label: "Recovered", value: 4.98 },
      ],
      note: "Held-out perplexity of the recurrent workload: a swept step size, the learned one, a deliberately bad start, and that bad start with learning.",
      max: 6,
    },
  },
  {
    running: "Tuning the Tuner",
    heading: "3.3 Taller stacks",
    paragraphs: [
      at(GRADIENT_POOL, 8),
      at(GRADIENT_POOL, 9),
      at(GRADIENT_POOL, 10),
    ],
    chart: {
      bars: [
        { label: "Height 1", value: 7.9 },
        { label: "Height 2", value: 6.1 },
        { label: "Height 3", value: 5.7 },
        { label: "Height 4", value: 5.6 },
      ],
      note: "Held-out perplexity of the recurrent workload as the stack grows, from a deliberately poor starting rate.",
      max: 10,
    },
  },
  {
    running: "Tuning the Tuner",
    heading: "3.4 Stacks on top of stacks",
    paragraphs: [
      "Section 2.1 describes how to wrap an optimiser inside another. To check that this scales, every workload was rerun with stacks of rising height and with bottom-level rates spread over several orders of magnitude.",
      "When the starting hyper-step sizes are far too large, training blows up on anything bigger than the small dense task. Each level therefore starts below the one beneath it. Our schedule looks like this: the rates for the upper levels step from ↵ = 105 down to 101, taking the values [↵ · 3, ↵ · 1, ↵ · 0.3], and the bottom level is held at ↵ = 102.",
      at(GRADIENT_POOL, 15),
      "The taller the stack, the flatter the curve of quality against the starting rate, which is the property the method was designed to produce.",
    ],
    anchors: [
      "When the starting hyper-step sizes are far too large, training blows up on anything bigger than the small dense task.",
      "Our schedule looks like this: the rates for the upper levels step from ↵ = 105 down to 101, taking the values [↵ · 3, ↵ · 1, ↵ · 0.3], and the bottom level is held at ↵ = 102.",
    ],
  },
  {
    running: "Tuning the Tuner",
    heading: "4 Cost",
    paragraphs: [
      at(GRADIENT_POOL, 17),
      "Cost rises with stack height and with the size of the update graph, and each extra level adds just 1–2% to the runtime over a run with no hyperoptimiser.",
      at(GRADIENT_POOL, 19),
    ],
    anchors: ["Each extra level adds just 1–2% to the runtime over a run with no hyperoptimiser."],
    table: {
      caption: "Table 3: Runtime of the recurrent workload by stack height.",
      columns: ["Height", "Runtime", "Over the baseline"],
      rows: [
        ["None", "1.00 h", "-"],
        ["1", "1.01 h", "1%"],
        ["2", "1.03 h", "3%"],
        ["3", "1.05 h", "5%"],
      ],
      weights: [1.4, 1.4, 1.6],
    },
  },
  {
    running: "Tuning the Tuner",
    heading: "5 In practice",
    paragraphs: [
      at(GRADIENT_POOL, 18),
      "The wrapper holds the update from the previous step and detaches it, so one step's graph is never joined back into the next.",
      "A few ready-made modules simply cannot be wrapped, because they rewrite the computation graph without saying so while keeping state of their own.",
      "For those we supply an explicit cell with the same interface and no hidden graph changes.",
    ],
    anchors: [
      "A few ready-made modules simply cannot be wrapped, because they rewrite the computation graph without saying so",
    ],
  },
  {
    running: "Tuning the Tuner",
    heading: "6 Closing remarks",
    paragraphs: [
      "The optimiser's settings can be learned by the very gradient descent that learns the model, provided the update is written into the graph and cut free between steps.",
      "The method is cheap, stacks to any height, and makes training less sensitive to a person's first guess.",
      "Where a sweep over learning rates is expensive, it should pay for itself; the code is released for others to try on their own models.",
    ],
  },
  {
    running: "Tuning the Tuner",
    heading: "References",
    paragraphs: [
      "[1] A. Author, B. Author and C. Author. Learning by gradient descent to learn by gradient descent. In Proceedings of the Conference on Neural Information Processing Systems, 2016.",
      "[2] A. Author and B. Author. Gradients through the update. A technical report, 2018.",
      "[3] A. Author, B. Author, C. Author and D. Author. Adapting the rate online. A technical report, 2019.",
      "[4] A. Author. A library for differentiable optimisation. A technical report, 2020.",
    ],
  },
];

const GPT2_POOL = [
  "A language model is trained on one job: given the tokens so far, say what comes next. That job needs no labels beyond plain text.",
  "The question this report asks is whether such a model, given enough text and enough capacity, starts doing tasks nobody trained it for, once the task is described in the prompt.",
  "To a degree it does. Reading comprehension, summarisation and translation all improve without any change to the parameters or the architecture for each task.",
  "The model and the training loop are kept as plain as possible; the effort goes into the corpus, which is assembled with a simple rule for finding pages a person would actually read.",
  "Each evaluation writes its input as a prompt in ordinary language, and the answer is whatever the model continues with. Nothing is trained on the task itself.",
  "Results are reported on the usual benchmarks for each task, beside systems that were trained on that task's labels where such numbers exist.",
  "Gains track model size, roughly linearly in the logarithm of the parameter count over the range trained here.",
  "Failures are reported too: long documents, arithmetic, and anything needing knowledge from outside the training text.",
  "The corpus was gathered by taking outbound links from a discussion board and keeping pages that its readers had recommended, a cheap stand-in for what people choose to read.",
  "Repeated pages, pages that were mostly markup, and pages with too little text were dropped; the rest became one large unlabelled corpus.",
  "A byte-level alphabet lets the model read any language without an unknown-token entry, keeps the vocabulary small, and means new text needs no preprocessing.",
  "The model is a stack of self-attention blocks in the established style, with normalisation moved to the input of each block, and it is trained with one objective throughout.",
  "No fine-tuning is done for any evaluation. Every number below comes from a hand-written prompt and a continuation read off the model.",
  "Reading comprehension is the strongest of the three: the model answers with the span that follows the question, and its score is set beside systems trained on the set.",
  "Summarisation is harder, because something has to be left out. A cue at the end of the prompt helps, and the summaries read well though they often miss the point.",
  "Translation is weakest, and it works best between languages that commonly appear together in the corpus, which suggests the model is drawing on parallel text it has seen.",
  "The corpus was tested by training the same model on a smaller curated set; the broader corpus gave lower loss on held-out text from many sources.",
  "A model can be fluent and wrong. That is discussed below, and fluency is never taken as evidence of accuracy.",
  "A smaller version of the model and a description of the data pipeline are released so that others can repeat the training and study the behaviour.",
  "A self-attention block costs the square of the context length, which caps how much text the model can read at once in our setup.",
  "Performance is reported against parameter count, and the trend is smooth on every task, with no sudden jump at any particular size.",
  "On a small sample the model's answers were compared with a person's: the topic is usually right and the detail is sometimes wrong.",
  "The results suggest that the size of the data and of the model matters more than task-specific design, at least for the tasks measured, and that the trend deserves more testing.",
  "The report closes with the failure modes we could see and with a note on how to measure them properly, including held-out sets that were not on the public web when the corpus was collected.",
];

const GPT2_HEADINGS = [
  "3.2 Children's book test",
  "3.3 LAMBADA",
  "3.4 Winograd",
  "3.8 Question answering",
  "4.1 Model capacity",
  "4.2 Data overlap",
  "4.3 Robustness",
  "4.4 Bias",
  "5 Discussion",
  "5.1 Limitations",
  "5.2 Future work",
  "6 Evaluations of the largest model",
];

export const GPT2: SamplePage[] = [
  {
    title: ["What a Corpus Teaches"],
    titleSize: 26,
    subtitle: [
      "Tasks a language model learns without labels",
      "A report from Wrennick Research",
    ],
    heading: "Summary",
    paragraphs: [
      "Question answering, translation, reading comprehension and summarisation are normally taught with labelled data for each task.",
      "This report shows that a language model picks up a good deal of each from unlabelled text alone, once it is trained on a new corpus of several million web pages called Longfield.",
      "Given a passage and a question, the answers it writes reach 41.8 F1 on one reading set, ahead of two of the three systems built for that set, while using none of its 96,000 labelled examples.",
      "Capacity matters: every task improves in a log-linear way as the model grows.",
    ],
    anchors: [],
    small: ["Prepared for software testing. The text is fictional."],
  },
  {
    running: "What a Corpus Teaches",
    heading: "1 Introduction",
    paragraphs: [
      at(GPT2_POOL, 0),
      at(GPT2_POOL, 1),
      "A language model can carry out tasks it was never trained on, in a zero-shot setting – with no change to its parameters or architecture.",
      at(GPT2_POOL, 3),
    ],
    anchors: [
      "A language model can carry out tasks it was never trained on, in a zero-shot setting – with no change to its parameters or architecture.",
    ],
  },
  {
    running: "What a Corpus Teaches",
    heading: "2 Building the corpus",
    paragraphs: [
      "The corpus is built from the open web, and the model is trained on it with a single objective: guess the next token.",
      "To gather it, we followed outbound links from a discussion board and kept the pages that had drawn at least 5 recommendations,",
      "as a rough sign that people found them worth reading. The corpus holds just over 5 million documents, some 23 GB of text,",
      "once repeats and pages whose text could not be extracted were removed.",
    ],
    anchors: [
      "we followed outbound links from a discussion board and kept the pages that had drawn at least 5 recommendations",
      "The corpus holds just over 5 million documents, some 23 GB of text,",
    ],
    table: {
      caption: "Table 1: The corpus by the year its pages were linked.",
      columns: ["Period", "Documents", "Text"],
      rows: [
        ["2015", "1.2 M", "5.2 GB"],
        ["2016", "1.3 M", "6.0 GB"],
        ["2017", "1.4 M", "6.4 GB"],
        ["2018", "1.1 M", "5.4 GB"],
        ["Total", "5.0 M", "23.0 GB"],
      ],
      weights: [1.4, 1.4, 1.4],
      bands: [4],
    },
  },
  {
    running: "What a Corpus Teaches",
    heading: "2.2 Reading bytes",
    paragraphs: [
      "A byte-level alphabet keeps the vocabulary small and means no text ever meets an unknown token.",
      "The vocabulary is 41,209 tokens, and the context window grows from 640 to 1152 tokens,",
      "so that longer passages, which the comprehension and summarisation sets need, fit inside one window.",
      at(GPT2_POOL, 10),
    ],
    anchors: [
      "The vocabulary is 41,209 tokens, and the context window grows from 640 to 1152 tokens,",
    ],
  },
  {
    running: "What a Corpus Teaches",
    heading: "3 What was measured",
    paragraphs: [at(GPT2_POOL, 4), at(GPT2_POOL, 5), at(GPT2_POOL, 6)],
    table: {
      caption: "Table 2: The four sizes trained for these measurements.",
      columns: ["Model", "Parameters", "Blocks", "Width"],
      rows: [
        ["Small", "95 M", "12", "704"],
        ["Medium", "280 M", "22", "960"],
        ["Large", "610 M", "34", "1216"],
        ["Largest", "1.1 B", "44", "1536"],
      ],
      weights: [1.4, 1.4, 1.2, 1.2],
    },
  },
  {
    running: "What a Corpus Teaches",
    heading: "3.6 Summarisation",
    paragraphs: [
      "Summaries are produced by asking for a shorter version of a news story; nothing in the model was trained on summaries.",
      "To make the job clear, we place the cue TL;DR: after the article",
      "and read what follows as the summary. That one cue is usually enough to get a short abstractive summary.",
      at(GPT2_POOL, 14),
    ],
    anchors: ["we place the cue TL;DR: after the article"],
  },
  {
    running: "What a Corpus Teaches",
    heading: "3.7 Translation",
    paragraphs: [at(GPT2_POOL, 15), at(GPT2_POOL, 16), at(GPT2_POOL, 21)],
    chart: {
      bars: [
        { label: "Small", value: 9.8 },
        { label: "Medium", value: 13.4 },
        { label: "Large", value: 16.1 },
        { label: "Largest", value: 18.7 },
      ],
      note: "Zero-shot translation score by model size, out of 100.",
    },
  },
  {
    running: "What a Corpus Teaches",
    heading: "3.1 Language modelling",
    paragraphs: [at(GPT2_POOL, 7), at(GPT2_POOL, 19)],
    table: {
      caption: "Table 3: Held-out loss on four collections, by model size.",
      columns: ["Collection", "Small", "Medium", "Largest"],
      rows: [
        ["News", "3.58", "3.19", "2.90"],
        ["Books", "3.26", "2.98", "2.72"],
        ["Web", "3.81", "3.40", "3.11"],
        ["Code", "3.02", "2.70", "2.46"],
      ],
      weights: [1.6, 1.2, 1.2, 1.2],
    },
  },
  {
    running: "What a Corpus Teaches",
    heading: "3.5 Reading comprehension",
    paragraphs: [at(GPT2_POOL, 12), at(GPT2_POOL, 13)],
    chart: {
      bars: [
        { label: "Small", value: 33.6 },
        { label: "Medium", value: 38.9 },
        { label: "Largest", value: 41.8 },
      ],
      note: "F1 on a reading comprehension set in the zero-shot setting, by model size.",
      max: 60,
    },
  },
  ...prose(GPT2_POOL, GPT2_HEADINGS, 3).map(
    (paragraphs, index): SamplePage => ({
      running: "What a Corpus Teaches",
      heading: at(GPT2_HEADINGS, index),
      paragraphs,
    }),
  ),
  {
    running: "What a Corpus Teaches",
    heading: "6 Closing remarks",
    paragraphs: [
      "A large model trained on a broad corpus can do several tasks without task-specific training, and its quality rises smoothly as it grows.",
      "The failures are reported as well as the successes; measuring them properly comes next, since fluency makes a mistake easy to miss.",
    ],
  },
  {
    running: "What a Corpus Teaches",
    heading: "References",
    paragraphs: [
      "[1] A. Author, B. Author and C. Author. Weighting keys for sequence models. A technical report, 2017.",
      "[2] A. Author and B. Author. Byte-level alphabets for large corpora. A technical report, 2018.",
      "[3] A. Author, B. Author, C. Author and D. Author. Reading comprehension with pretrained models. A technical report, 2018.",
      "[4] A. Author. A survey of zero-shot transfer. A technical report, 2019.",
    ],
  },
  {
    running: "What a Corpus Teaches",
    heading: "Appendix A: Prompts",
    paragraphs: [
      "The prompts used for each evaluation are listed here exactly as they were given, with one sample continuation beside each.",
      "Every prompt closes with a short cue naming the task in everyday words, such as a question mark for questions and a separator for summaries.",
    ],
    table: {
      caption: "Table 4: The prompts used, by evaluation.",
      columns: ["Evaluation", "Cue", "Answer read"],
      rows: [
        ["Reading comprehension", "Question about the passage", "The text after the question"],
        ["Summarisation", "TL;DR: after the article", "The next two sentences"],
        ["Translation", "A source sentence, then =", "The sentence after the equals sign"],
        ["Question answering", "Q: ... A:", "The text after A:"],
      ],
      weights: [2, 2.4, 2.4],
    },
  },
];

const GPT3_POOL = [
  "It has become clear that a model trained on a large corpus can be pointed at a new task with a short prompt instead of a change to its weights.",
  "This report pushes that observation to a much larger scale: a model with 220 billion parameters is measured on many tasks, with no examples, one example, or a handful in the prompt.",
  "The training mixture combines web pages, books, articles and code, filtered for breadth and for the quality of the prose.",
  "The architecture is autoregressive and the objective is next-token prediction, as in earlier work; there is no task-specific head and no fine-tuning step.",
  "Short answers are scored by exact match or accuracy, longer answers by the overlap score F1.",
  "On many tasks a handful of examples in the prompt brings the model close to a system trained on the task's labelled set, and sometimes past it.",
  "The benefit of examples is largest where the answer's shape is easy to copy from them, and smallest where several steps of reasoning are needed.",
  "Confidence is measured as well as accuracy, and the model turns out to be too sure of the answers it gets wrong, more so at larger sizes.",
  "Eight sizes are reported, from 110 million to 220 billion parameters, so that each task shows a trend rather than one large-model number.",
  "Bigger models need fewer examples to reach a given score, and the score rises smoothly as examples are added.",
  "A few benchmarks get worse at the largest size. We put that down to prompt format rather than to a loss of ability.",
  "Overlap between the training mixture and each benchmark is measured and reported, since a large overlap would flatter the results.",
  "The same prompt format covers writing code from a description, answering questions about a passage, and translating between languages.",
  "No claim is made that the model reasons about its answers; it sometimes gives the right answer with an explanation a person would not give.",
  "Training compute is reported, and it is large: thousands of accelerators for several weeks.",
  "The environmental cost of a run this size is discussed, with the energy used and the offsets bought.",
  "Output can do harm: it can repeat the biases of its training data, invent plausible falsehoods, and produce misleading text at scale.",
  "The measures taken to filter the data and to limit harmful output are described, along with what they cannot do.",
  "Prompts, answer formats and scoring rules for every benchmark are listed in the appendix so that the results can be repeated.",
  "The model is offered through an interface rather than as weights, so that use can be watched while the risks are studied.",
  "Scale alone buys a great deal of general ability, and returns from a larger model were still positive across the range trained here.",
  "How much of the gain belongs to the data rather than the parameters is open; an ablation trains a small model on more text and a large one on less, holding compute fixed.",
  "Prompt wording is another open question. A small rewording can move a score by several points, which makes cross-paper comparisons awkward.",
  "The report ends with what the results do and do not show, and with evaluations we would run if the data or the metric existed.",
];

const GPT3_PROSE_A = [
  "3.2 Closed-book question answering",
  "3.3 Reading comprehension",
  "3.4 Translation",
  "3.5 Winograd schemas",
  "3.6 Common-sense reasoning",
  "3.7 Arithmetic",
  "3.8 Word scrambling",
  "3.9 News generation",
  "3.10 Learning and using tools",
  "4.2 Calibration",
  "4.3 Prompt sensitivity",
  "4.4 Few-shot versus fine-tuning",
];

const GPT3_PROSE_B = [
  "5.1 Energy use",
  "5.4 Fairness",
  "6.2 Broader impacts",
  "6.3 Open questions",
  "6.4 Evaluation protocol",
  "6.5 Data documentation",
  "6.6 Deployment and access",
  "6.7 Future work",
];

export const GPT3: SamplePage[] = [
  {
    title: ["Demonstrations, Not Weights"],
    titleSize: 26,
    subtitle: [
      "Task transfer at 220 billion parameters",
      "A report from Brellan AI Research",
    ],
    heading: "Summary",
    paragraphs: [
      "A 220 billion parameter autoregressive language model was measured on many tasks with no examples, one example and a handful of examples in its prompt.",
      "With a few demonstrations the model comes close, on many tasks, to systems trained on the task's own data, and no weights change at any point.",
      "Tasks on which it fails are reported beside the ones it passes, together with an analysis of overlap between the training mixture and the benchmarks.",
    ],
    small: ["Prepared for software testing. The text is fictional."],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "Contents",
    paragraphs: [
      "1 Introduction 3",
      "2 Approach 6",
      "3 Results 8",
      "4 Measuring and limiting contamination 9",
      "5 Broader impacts 34",
      "6 Limitations 34",
      "7 Conclusion 36",
      "Appendix A: Details of the models 37",
      "Appendix B: Details of the data 41",
      "Appendix C: Additional results 45",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "1 Introduction",
    paragraphs: [
      at(GPT3_POOL, 0),
      at(GPT3_POOL, 1),
      "The approach is deliberately plain: model and objective stay as they were, and only the prompt's text changes, so that a gain can be credited to the model's use of the examples rather than to a new training method.",
      at(GPT3_POOL, 3),
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "1.1 Three settings",
    paragraphs: [
      "Three settings run through the report: zero-shot, with only a description of the task; one-shot, with a single worked example; and few-shot, with a handful of examples, usually between ten and a hundred.",
      at(GPT3_POOL, 6),
    ],
    table: {
      caption: "Table 1: The eight sizes and their depth and width.",
      columns: ["Parameters", "Blocks", "Width", "Heads"],
      rows: [
        ["110 M", "10", "640", "10"],
        ["320 M", "16", "896", "12"],
        ["700 M", "20", "1280", "16"],
        ["1.4 B", "24", "1792", "24"],
        ["3.1 B", "30", "2304", "30"],
        ["7.4 B", "36", "3584", "36"],
        ["16 B", "44", "4608", "44"],
        ["220 B", "72", "10240", "72"],
      ],
      weights: [1.2, 1.2, 1.2, 1.2],
      bands: [7],
    },
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "2 Approach",
    paragraphs: [
      "The pre-training recipe follows our earlier report, with a much larger scale and a broader mixture of text.",
      "The family is autoregressive, training a 220 billion parameter autoregressive language model, which we call Brellan-220B,",
      "and its members are named by parameter count.",
      "Zero-shot scores rise steadily with size, and few-shot scores rise faster,",
      "so the difference between the two settings grows as the model does.",
      "Nothing in these “learning” curves involves a gradient update or a fine-tune — the prompt simply carries more examples.",
      "Brellan-220B, for instance, scores 71.2 F1 on the Quill reading set with no examples, 74.8 with one and 77.5 with several.",
      "Some tasks, however, remain difficult for prompting even at this size.",
    ],
    anchors: [
      "training a 220 billion parameter autoregressive language model, which we call Brellan-220B",
      "Zero-shot scores rise steadily with size, and few-shot scores rise faster,",
      "Nothing in these “learning” curves involves a gradient update or a fine-tune — the prompt simply carries more examples.",
      "Brellan-220B, for instance, scores 71.2 F1 on the Quill reading set with no examples, 74.8 with one and 77.5 with several.",
      "Some tasks, however, remain difficult for prompting even at this size.",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "2.1 Definitions",
    paragraphs: [
      "We use Few-Shot (FS) for the setting in which a handful of worked examples are placed in the prompt and the weights stay frozen",
      "and no task-specific data is used beyond those examples.",
      "One-shot means a single example, and zero-shot means none: only a plain-language description of the task is given.",
      "The number of examples stays small, ten to a hundred, so that the prompt fits the context and the setup resembles what a person could type by hand.",
    ],
    anchors: [
      "We use Few-Shot (FS) for the setting in which a handful of worked examples are placed in the prompt and the weights stay frozen",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "2.2 Training mixture",
    paragraphs: [
      at(GPT3_POOL, 2),
      at(GPT3_POOL, 9),
      "Documents are deduplicated, and pages that are mostly boilerplate or that repeat text found elsewhere are dropped.",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "2.3 Filtering",
    paragraphs: [
      "The web portion was scored by a classifier trained to tell prose resembling a curated corpus from prose that does not, and pages were kept in proportion to that score.",
      "The raw crawl is large: 26TB of text before filtering, and 310GB after,",
      "which is the version used for training, alongside books, articles and code.",
      "Every model in the family saw 210 billion tokens.",
      "Our eight sizes span 110 million to 220 billion parameters",
      "and share one dataset, so that a single set of runs shows the effect of size.",
      "The architecture follows Wrennick-LM, with the changes noted below,",
      "which keeps the comparison with the earlier numbers as direct as it can be.",
    ],
    anchors: [
      "26TB of text before filtering, and 310GB after",
      "Every model in the family saw 210 billion tokens.",
      "Our eight sizes span 110 million to 220 billion parameters",
      "The architecture follows Wrennick-LM, with the changes noted below,",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "2.4 The training run",
    paragraphs: [
      "Training ran on the Kestrel cluster, which a partner organisation provided,",
      "for the largest models, with smaller ones on the same cluster at proportionally smaller scale.",
      "The mixture was sampled by size rather than by dataset: some parts of the mixture were repeated up to 2.6 times, others were never seen in full.",
      "Benchmarks were checked against the training text. A filtering bug let some of that overlap through, and training the model again at this cost was out of reach,",
      "so the overlap is reported per benchmark, and results are analysed with and without the affected items.",
    ],
    anchors: [
      "Training ran on the Kestrel cluster, which a partner organisation provided",
      "some parts of the mixture were repeated up to 2.6 times, others were never seen in full.",
      "A filtering bug let some of that overlap through, and training the model again at this cost was out of reach",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "3 Results",
    paragraphs: [at(GPT3_POOL, 4), at(GPT3_POOL, 5), at(GPT3_POOL, 7)],
    table: {
      caption: "Table 2: Scores on six benchmarks with no examples, one and several, for the largest model.",
      columns: ["Benchmark", "Zero-shot", "One-shot", "Few-shot"],
      rows: [
        ["Reading comprehension", "58.1", "63.4", "69.7"],
        ["Question answering", "49.6", "54.2", "58.9"],
        ["Translation", "18.3", "21.7", "23.5"],
        ["Word puzzles", "57.2", "66.8", "73.1"],
        ["Common sense", "62.4", "64.9", "67.0"],
        ["Arithmetic", "15.1", "18.6", "22.9"],
      ],
      weights: [2.2, 1.3, 1.3, 1.3],
      bands: [3],
    },
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "3.1 Language modelling",
    paragraphs: [at(GPT3_POOL, 8), at(GPT3_POOL, 9)],
    chart: {
      bars: [
        { label: "0-shot", value: 58.1 },
        { label: "1-shot", value: 63.4 },
        { label: "Few-shot", value: 69.7 },
        { label: "Fine-tuned", value: 72.3 },
      ],
      note: "Score on a reading benchmark by the number of demonstrations in the prompt, beside a fine-tuned system of the previous generation.",
      max: 90,
    },
  },
  ...prose(GPT3_POOL, GPT3_PROSE_A, 3).map(
    (paragraphs, index): SamplePage => ({
      running: "Demonstrations, Not Weights",
      heading: at(GPT3_PROSE_A, index),
      paragraphs,
    }),
  ),
  {
    running: "Demonstrations, Not Weights",
    heading: "3.11 Analogical reasoning",
    paragraphs: [
      "On word-relationship puzzles taken from an admissions test, the few-shot score was compared with the scores of people who sat the same test.",
      "The score improved with size, and at the largest size it came close to the human average, which was 48% on the same set.",
      "The comparison is loose: applicants were timed and the model was not.",
      at(GPT3_POOL, 22),
    ],
    anchors: ["which was 48% on the same set"],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "4.1 Measuring overlap",
    paragraphs: [at(GPT3_POOL, 11), at(GPT3_POOL, 12), at(GPT3_POOL, 21)],
    table: {
      caption: "Table 3: The share of each benchmark whose text appears in training, with scores on the clean and overlapping parts.",
      columns: ["Benchmark", "Overlap", "Clean", "Overlapping"],
      rows: [
        ["Reading comprehension", "1.5%", "68.9", "76.2"],
        ["Question answering", "0.6%", "58.2", "60.1"],
        ["Translation", "0.0%", "23.5", "-"],
        ["Arithmetic", "0.0%", "22.9", "-"],
      ],
      weights: [2.2, 1.2, 1.2, 1.4],
    },
  },
  ...prose(GPT3_POOL, GPT3_PROSE_B, 3).map(
    (paragraphs, index): SamplePage => ({
      running: "Demonstrations, Not Weights",
      heading: at(GPT3_PROSE_B, index),
      paragraphs,
    }),
  ),
  {
    running: "Demonstrations, Not Weights",
    heading: "6.1 Limitations",
    paragraphs: [
      "Text-only training leaves a model with no grounding in video, touch or the physical world,",
      "and what it learns comes from writing alone, which leaves out a great deal that a person knows.",
      "Pre-training is also hungry for data: reaching this quality took an enormous corpus.",
      "Learning a new task from a handful of examples is still less reliable than it is for a person.",
      at(GPT3_POOL, 16),
    ],
    anchors: [
      "Text-only training leaves a model with no grounding in video, touch or the physical world,",
      "Pre-training is also hungry for data: reaching this quality took an enormous corpus.",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "5.2 Misuse",
    paragraphs: [
      "Better text synthesis also means more scope for misuse.",
      "The model writes fluent, on-topic and false text at a scale nobody could match, which suits spam, fraud and disinformation.",
      at(GPT3_POOL, 17),
    ],
    anchors: ["Better text synthesis also means more scope for misuse."],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "5.3 Bias",
    paragraphs: [
      "A model trained on the open web inherits the web's biases, at web scale,",
      "and this one reflects what it read. Gender and occupation are associated across a set of prompts in ways that repeat the stereotypes in the data.",
      at(GPT3_POOL, 18),
    ],
    anchors: ["A model trained on the open web inherits the web's biases, at web scale,"],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "7 Conclusion",
    paragraphs: [
      "A 220 billion parameter model performs many tasks from a prompt alone, and its quality rises smoothly with parameters and with the number of examples in the prompt.",
      "Failures are reported as fully as successes, and the limits of the overlap analysis are stated.",
      "The results argue for studying scale carefully, and for measuring the risks of large models while they are being built rather than afterwards.",
    ],
  },
  {
    running: "Demonstrations, Not Weights",
    heading: "Appendix A: The models",
    paragraphs: [at(GPT3_POOL, 19), at(GPT3_POOL, 20)],
    table: {
      caption: "Table 4: Training compute and tokens by size.",
      columns: ["Parameters", "Tokens", "Accelerator days"],
      rows: [
        ["110 M", "210 B", "0.2"],
        ["1.4 B", "210 B", "1.0"],
        ["16 B", "210 B", "10.5"],
        ["220 B", "210 B", "2,740"],
      ],
      weights: [1.4, 1.4, 1.8],
      bands: [3],
    },
  },
  ...Array.from({ length: 36 }, (_, index): SamplePage => {
    const page = index + 39;
    const rows = Array.from({ length: 9 }, (_, row) => {
      const value = 35 + ((page * 7 + row * 13) % 60);
      return [
        `${page}.${row + 1}`,
        `Benchmark ${String.fromCharCode(65 + (row % 6))}${row + 1}`,
        `${value}.${row % 10}`,
        `${value - 4}.${(row * 3) % 10}`,
      ];
    });
    return {
      running: "Demonstrations, Not Weights",
      heading: `Appendix C.${index + 1}: Additional results`,
      paragraphs: [
        at(GPT3_POOL, index * 3),
        "The table carries the full results for this group of benchmarks, with no examples and with several, for every size trained.",
      ],
      table: {
        caption: `Table ${5 + index}: Results for the benchmarks in this group.`,
        columns: ["Task", "Benchmark", "Zero-shot", "Few-shot"],
        rows,
        weights: [1, 2.4, 1.4, 1.4],
      },
    };
  }),
  {
    running: "Demonstrations, Not Weights",
    heading: "References",
    paragraphs: [
      "[1] A. Author, B. Author and C. Author. Weighting keys for sequence models. A technical report, 2017.",
      "[2] A. Author, B. Author and C. Author. What a corpus teaches. A technical report, 2019.",
      "[3] A. Author and B. Author. Reading comprehension with pretrained models. A technical report, 2019.",
      "[4] A. Author, B. Author and C. Author. Overlap between training and evaluation data. A technical report, 2020.",
      "[5] A. Author. Energy and policy considerations for deep learning. A technical report, 2019.",
    ],
  },
];
