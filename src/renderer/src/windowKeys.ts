import { Editor, getExtensionField, getSchemaTypeByName } from "@tiptap/core";
import { MENU_COMMANDS } from "../../shared/commands";
import { keysForm, keysOn } from "./commands/keys";
import { commands } from "./commands/registry";
import { noteExtensions } from "./editor/noteSchema";
import { SmartTypography } from "./editor/typography";
import { TAGS_KEYS } from "./treeKeys";

function editorShortcuts(): string[] {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), SmartTypography],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  try {
    return editor.extensionManager.extensions.flatMap((extension) => {
      const add = getExtensionField<() => Record<string, unknown>>(
        extension,
        "addKeyboardShortcuts",
        {
          name: extension.name,
          options: extension.options,
          storage: editor.extensionStorage[extension.name as keyof typeof editor.extensionStorage],
          editor,
          type: getSchemaTypeByName(extension.name, editor.schema),
        },
      );
      return add ? Object.keys(add()) : [];
    });
  } finally {
    editor.destroy();
  }
}

function editorKeyForms(mac: boolean): string[] {
  const forms: string[] = [];
  for (const shortcut of editorShortcuts()) {
    const parts = shortcut.split("-");
    const key = parts.pop() ?? "";
    const code = /^[a-z]$/i.test(key)
      ? `Key${key.toUpperCase()}`
      : /^\d$/.test(key)
        ? `Digit${key}`
        : null;
    // Only a letter or a digit can be a global shortcut here; the editor binds no F-key.
    if (!code) continue;
    const has = (...names: string[]) => parts.some((part) => names.includes(part));
    forms.push(
      [
        (has("Meta", "Cmd") || (mac && has("Mod"))) && "meta",
        (has("Ctrl", "Control") || (!mac && has("Mod"))) && "ctrl",
        has("Alt", "Option") && "alt",
        has("Shift") && "shift",
        code,
      ]
        .filter(Boolean)
        .join("+"),
    );
  }
  return forms;
}

/**
 * The keys the window binds itself, in the form `keysForm` gives: the commands' (⌘K's and the
 * keymap's), the menu's, the note editor's, and the Library row's Tags…, which the tree binds
 * rather than a command. A meeting key the User set to one of these is dropped while a main
 * window is in front.
 */
export function windowKeyForms(mac: boolean): Set<string> {
  const forms = new Set<string>();
  for (const command of commands.all()) {
    const { shortcut } = command;
    if (shortcut && !(shortcut.macOnly && !mac)) {
      for (const keys of [
        keysOn(shortcut.keys, mac),
        ...(!mac && shortcut.alsoOther ? [shortcut.alsoOther] : []),
        ...(shortcut.also ? [shortcut.also] : []),
      ]) {
        forms.add(keysForm(keys, mac));
      }
    }
    if (command.rowKeys) forms.add(keysForm(keysOn(command.rowKeys, mac), mac));
  }
  for (const { keys } of Object.values(MENU_COMMANDS)) {
    if (keys) forms.add(keysForm(keys, mac));
  }
  forms.add(keysForm(TAGS_KEYS, mac));
  for (const form of editorKeyForms(mac)) forms.add(form);
  return forms;
}

const known = new Map<boolean, Set<string>>();

export function windowKeysOf(mac: boolean): ReadonlySet<string> {
  let forms = known.get(mac);
  if (!forms) {
    forms = windowKeyForms(mac);
    known.set(mac, forms);
  }
  return forms;
}
