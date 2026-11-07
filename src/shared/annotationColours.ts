/** The five highlight colours and the words the interface names them by. */
import type { AnnotationColour } from "../core/api";
import type { MessageKey } from "./i18n";

export const ANNOTATION_COLOUR_LABELS: Record<AnnotationColour, MessageKey> = {
  yellow: "annotations.colour.yellow",
  green: "annotations.colour.green",
  blue: "annotations.colour.blue",
  pink: "annotations.colour.pink",
  purple: "annotations.colour.purple",
};
