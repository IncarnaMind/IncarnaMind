import { addFilesLabelByPlatform } from "../../shared/addFilesAction";
import type { MessageKey } from "../../shared/i18n";

const filesAndAFolder = /Mac/.test(navigator.platform);

/** The one way in's words on this computer: files and a folder on macOS, files elsewhere (#1942). */
export const addFilesLabel = (): MessageKey => addFilesLabelByPlatform(filesAndAFolder);
