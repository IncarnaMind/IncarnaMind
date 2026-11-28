import { useRequests } from "../requests";
import { DeleteNoteConversationDialog } from "./DeleteNoteConversationDialog";
import { DeletePermanentlyDialog } from "./DeletePermanentlyDialog";
import { UnlinkFolderDialog } from "./UnlinkFolderDialog";

export function RequestedDialogs() {
  const { unlink, deletePermanently, deleteNoteConversation, clear } = useRequests();
  return (
    <>
      <DeletePermanentlyDialog
        request={deletePermanently}
        onClose={() => clear("deletePermanently")}
      />
      <DeleteNoteConversationDialog
        conversation={deleteNoteConversation}
        onClose={() => clear("deleteNoteConversation")}
      />
      <UnlinkFolderDialog target={unlink} onClose={() => clear("unlink")} />
    </>
  );
}
