/**
 * Test hooks, present only when the app was launched with
 * INCARNAMIND_TEST_HOOKS=1 (the main process then adds `?testHooks` to the
 * page URL): open a Document at a page range and quote, as a Citation does
 * from the group the User is in, and, not about the viewer, answer the Skill
 * picker without the system's dialog, add files and folders by path as a drop
 * would, or wait for, slow down and look at what moves, shorten how long an Answer
 * is silent before its line says how long it takes, read the command registry
 * as data, give Home's Coming up its meetings, or hold back the citation style
 * picker's list of every style.
 */
import type { TestHooks } from "../../shared/testHooks";
import { setSilentWaitMs } from "./answerWaitWords";
import { holdStyleCatalogue } from "./citationStylePicker";
import { useComingUp } from "./comingUp";
import { menuEntries, menuKinds } from "./commands/menus";
import { COMMAND_GROUPS, commands } from "./commands/registry";
import { usePanelFault } from "./components/PanelBoundary";
import { findable } from "./finding";
import { currentTabOf } from "./layoutSlice";
import { leavingCopies, motionRunning, setMotionSpeed } from "./motion";
import { interceptSkillPicker } from "./skills";
import { useAppStore } from "./store";

declare global {
  interface Window {
    incarnamindTestHooks?: TestHooks;
  }
}

export function installTestHooks(): void {
  if (!new URLSearchParams(window.location.search).has("testHooks")) return;
  window.incarnamindTestHooks = {
    openDocument: (location) => {
      const { layout, openDocument } = useAppStore.getState();
      // From the Mind the User is in, as a Citation in it; with no Mind in front, as from a list.
      if (currentTabOf(layout)?.item.kind === "mind" && layout) {
        openDocument(location, { as: "citation", from: layout.focusedGroupId });
      } else openDocument(location, { as: "list" });
    },
    interceptSkillPicker,
    addPaths: (paths) => useAppStore.getState().addPaths(paths),
    failPanel: (name) => usePanelFault.setState({ failing: name }),
    registry: () => ({
      groups: COMMAND_GROUPS,
      menus: Object.fromEntries(menuKinds().map((kind) => [kind, [...menuEntries(kind)]])),
      commands: Object.fromEntries(
        commands.all().map((command) => [
          command.id,
          {
            group: command.group,
            reversible: command.reversible === true,
            destructive: command.destructive === true,
            // F2 renames in any list, as the row or the tab list binds it.
            renames: (command.rowKeys ?? command.shortcut?.keys) === "F2",
          },
        ]),
      ),
      found: findable.all().map((kind) => kind.kind),
    }),
    setSilentWaitMs,
    setComingUp: (meetings) => useComingUp.setState({ meetings }),
    holdStyleCatalogue,
    motionRunning,
    setMotionSpeed,
    leavingCopies,
  };
}
