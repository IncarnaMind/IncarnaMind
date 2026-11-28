import { useRequests } from "../requests";
import { DeletePermanentlyDialog } from "./DeletePermanentlyDialog";
import { UnlinkFolderDialog } from "./UnlinkFolderDialog";

export function RequestedDialogs() {
  const { unlink, deletePermanently, clear } = useRequests();
  return (
    <>
      <DeletePermanentlyDialog
        request={deletePermanently}
        onClose={() => clear("deletePermanently")}
      />
      <UnlinkFolderDialog target={unlink} onClose={() => clear("unlink")} />
    </>
  );
}
