import { useState } from "react";
import type { TaggingModels } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { catalogProvider } from "../../../../core/providers/catalog/providers";
import { useGap, useLanguage, useT } from "../../i18n";
import { DecisionSortingSetUp, firstModelOf } from "../providers/DecisionKeyForm";
import { JevSortingSetUp } from "../providers/JevSortingSetUp";
import { SortingSelect, type useSorting } from "../providers/SortingChoice";
import {
  keyProviderOf,
  type SetUpOffer,
  type SortingOption,
  sortingKey,
} from "../providers/sortingOptions";
import { ReadProblem } from "../ReadProblem";
import { OtherModelForm } from "./OtherSortingModel";
import { popUpWidth } from "./RoleSelect";

type Translate = ReturnType<typeof useT>;

/** Who pays for a sorting model, as the core groups its list; a plan by its own name. */
type SortingPayer = { kind: "plan"; name: string } | { kind: "keys" } | { kind: "local" };

/**
 * Everything that can sort, grouped by who pays: the curated list first (the best each key
 * reaches, Jev, the User's AI model, the models on this computer), then every other model the
 * core lists.
 */
export function organizeGroups(
  shown: readonly SortingOption[],
  models: TaggingModels | null,
  language: Language,
  t: Translate,
): { label: string; options: SortingOption[] }[] {
  const words = language === "zh-CN" ? "zh" : "en";
  const listed = new Map(
    (models?.options ?? []).map((each) => [sortingKey(each.classifier), each]),
  );
  // The local decision models under Automatic read as in the full list, whichever lists them.
  const all = shown.map((each) =>
    each.classifier.kind === "auto" ? { ...each, label: t("tagging.decision.auto") } : each,
  );
  const seen = new Set(shown.map((each) => sortingKey(each.classifier)));
  for (const each of models?.options ?? []) {
    const key = sortingKey(each.classifier);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = each.classifier.kind === "auto" ? t("tagging.decision.auto") : each.name;
    const provider = each.provider ? each.provider[words] : null;
    all.push({
      classifier: each.classifier,
      label: provider ? `${name} · ${provider}` : name,
      provider: each.group === "local" ? null : provider,
      decisionModel: each.decisionModel,
      ...(each.classifier.kind === "chat" && { modelName: each.name }),
    });
  }
  const payerOf = (option: SortingOption): SortingPayer => {
    const known = listed.get(sortingKey(option.classifier));
    if (known?.group === "plan") return { kind: "plan", name: known.provider?.[words] ?? "" };
    if (known?.group === "local" || (!known && option.provider === null)) return { kind: "local" };
    return { kind: "keys" };
  };
  const labelOf = (payer: SortingPayer) =>
    payer.kind === "plan"
      ? t("ai.payer.plan", { plan: payer.name })
      : t(payer.kind === "keys" ? "ai.payer.keys" : "ai.payer.local");
  const groups = new Map<string, { rank: number; label: string; options: SortingOption[] }>();
  for (const option of all) {
    const payer = payerOf(option);
    const label = labelOf(payer);
    const rank = payer.kind === "plan" ? 0 : payer.kind === "keys" ? 1 : 2;
    const group = groups.get(label);
    if (group) group.options.push(option);
    else groups.set(label, { rank, label, options: [option] });
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ label, options }) => ({ label, options }));
}

/**
 * The choice of the one model for Organize, Tags and meeting hints, set up in place from its
 * picker's foot (Jev, a decision model host, another model by name): Settings › AI's Organize and
 * Tags row draws it, and so does first run's Your AI step (#3570), so it is one setting with one
 * set of words. It returns the pop-up (`control`, none while the read of what can sort has failed)
 * and what goes `below` it: that problem, or the form of the model being set up (`settingUp`), or
 * the key a chosen host uses.
 */
export function useSortingPicker(id: string, sorting: ReturnType<typeof useSorting>) {
  const t = useT();
  const language = useLanguage();
  const { settingsOptions, current, choose, read, library, setUpOffers, jevSettings } = sorting;
  const { decisionHosts, reread } = sorting;
  const [settingUp, setSettingUp] = useState<SetUpOffer["id"] | null>(null);
  const failed = read.state === "failed";
  const close = () => {
    setSettingUp(null);
    document.getElementById(id)?.focus();
  };
  const host = decisionHosts?.find((each) => each.host === settingUp);
  const keyProvider = keyProviderOf(current, decisionHosts);
  const models = read.state === "ready" ? read.data : null;
  const saved = library?.settings.classifier ?? null;

  const control = failed ? undefined : (
    <SortingSelect
      id={id}
      popUp
      className={popUpWidth}
      options={settingsOptions}
      groups={organizeGroups(settingsOptions, models, language, t)}
      current={current}
      setUp={{
        offers: [...setUpOffers, { id: "other", label: t("tagging.other") }],
        open: settingUp,
        onChoose: setSettingUp,
      }}
      onChange={(option) => {
        setSettingUp(null);
        void choose(option);
      }}
    />
  );

  const chosen = async (classifier: SortingOption["classifier"]) => {
    const done = await choose({ classifier });
    reread();
    return done;
  };
  let below = null;
  if (failed) {
    below = (
      <ReadProblem words={t("setup.sorting.failed")} read={read} testId="models-sorting-problem" />
    );
  } else if (settingUp === "jev" && jevSettings) {
    // Choosing here never turns tagging on: its own switch does, with its line (#2308).
    below = (
      <JevSortingSetUp
        jev={jevSettings}
        choose={() => chosen({ kind: "jev" })}
        onChosen={close}
        onCancel={close}
      />
    );
  } else if (settingUp === "other") {
    below = (
      <OtherModelForm
        current={saved && saved.kind !== "automatic" ? saved : null}
        onSave={(classifier) => {
          void choose({ classifier }).then((done) => {
            if (done) close();
          });
        }}
      />
    );
  } else if (host) {
    below = (
      <DecisionSortingSetUp
        key={host.host}
        host={host}
        choose={() => chosen(firstModelOf(host))}
        onChosen={close}
        onCancel={close}
      />
    );
  } else if (keyProvider && !current?.unresolved) {
    below = <UsesKeyLine catalogId={keyProvider} />;
  }
  return { control, below, failed, settingUp: settingUp !== null };
}

/** The chat provider's key the chosen decision model uses, which Accounts and keys lists as that company (#1907). */
function UsesKeyLine({ catalogId }: { catalogId: string }) {
  const t = useT();
  const language = useLanguage();
  const spaced = useGap();
  const named = catalogProvider(catalogId)?.name[language === "zh-CN" ? "zh" : "en"] ?? catalogId;
  // The Chinese line has no spaces of its own: a Latin name gets them, a Chinese one none.
  const provider =
    language === "zh-CN" ? `${spaced("汉", named)}${named}${spaced(named, "汉")}` : named;
  return (
    <p data-testid="models-sorting-key" className="text-[12px] leading-5 text-ink-meta">
      {t("decisions.usesKey", { provider })}
    </p>
  );
}
