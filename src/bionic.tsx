import { Fragment, type ReactNode } from "react";

// "Bionic Reading": bold the leading portion of each word so the eye fixates on
// it and the brain fills in the rest, which many readers find faster and less
// tiring. Letters only — punctuation, spaces and hyphens split words (so
// "in-depth" becomes two fixations: "in" + "depth"), apostrophes don't
// ("don't" stays one word).
const WORD_RE = /\p{L}[\p{L}\p{M}'’]*/gu;

// Bold the first half of the word, rounding up. Matches the canonical look:
// focusing→focu, brain→bra, understanding→underst, of→o, the→th.
const boldLength = (len: number) => Math.ceil(len / 2);

export function bionic(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const word = m[0];
    const head = boldLength(word.length);
    out.push(
      <Fragment key={key++}>
        <b className="bionic-fix">{word.slice(0, head)}</b>
        {word.slice(head)}
      </Fragment>
    );
    last = m.index + word.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
