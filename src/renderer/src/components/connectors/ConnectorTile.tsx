/**
 * A Connector's tile: its name's first letter on a neutral square (#148), as
 * Settings › Connectors shows each service, no brand logo. 32px in a list,
 * 44px at the head of its page.
 */
export function ConnectorTile({ name, large = false }: { name: string; large?: boolean }) {
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center bg-chip text-ink-secondary ${
        large ? "size-11 rounded-[10px] text-body" : "size-8 rounded-lg text-ui"
      }`}
    >
      {letter}
    </span>
  );
}
