import { nameCharacter } from "../../../shared/apiKey";
import { useT } from "../i18n";
import { FieldProblem } from "./FieldProblem";

export function KeyCharacterLine({ id, stray }: { id: string; stray: string }) {
  const t = useT();
  return (
    <FieldProblem id={id} testId="key-character-line">
      {t("error.provider.keyCharacter", { character: nameCharacter(stray) })}
    </FieldProblem>
  );
}
