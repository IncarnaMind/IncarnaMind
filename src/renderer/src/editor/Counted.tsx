/** A count's words with the number in bold, as the card's rows show it: "**3** not checked". */
export function Counted({ text, count }: { text: string; count: string }) {
  const at = text.indexOf(count);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b className="check-count">{count}</b>
      {text.slice(at + count.length)}
    </>
  );
}
