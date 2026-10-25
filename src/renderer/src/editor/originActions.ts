import type { BlockOrigin } from "../../../core/api";
import { openConversation } from "../conversations";
import { core } from "../core";
import { translateNow as t } from "../i18n";
import { type NoticeAction, useNotices } from "../notices";
import { restoreItems, useDeleted } from "../recentlyDeleted";
import { useAppStore } from "../store";

/**
 * Opens the conversation a Block was added from, in the assistant at its
 * Answer, flashed (#745). One in Recently deleted, or gone, is said to be.
 */
export async function openOrigin(origin: BlockOrigin): Promise<void> {
  if (origin.from.artifactKind !== "conversation") return;
  const { artifactId, anchor } = origin.from;
  const messageId = anchor.kind === "message" ? anchor.messageId : undefined;
  try {
    const target = await core.resolveReference(origin.from);
    if (target.status === "available") {
      await openConversation(artifactId, messageId);
      return;
    }
    const title = "name" in target && target.name ? target.name : t("conversation.untitled");
    const restore: NoticeAction | undefined =
      target.status === "deleted"
        ? {
            label: (t) => t("deleted.restore"),
            run: async () => {
              await useDeleted.getState().refresh();
              await restoreItems(
                (useDeleted.getState().items ?? []).filter(
                  (item) => item.kind === "conversation" && item.id === artifactId,
                ),
              );
              await openConversation(artifactId, messageId);
            },
          }
        : undefined;
    useNotices
      .getState()
      .showError(
        new Error(target.status === "deleted" ? t("origin.deleted", { title }) : t("origin.gone")),
        restore,
      );
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
