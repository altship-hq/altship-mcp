import type { ReactNode } from "react";

// Renders the Markdown agents write in their answers (bold, links, lists,
// headings, rules, code) as React elements. Deliberately small: nothing is
// injected as HTML, and links only go to http(s) or mailto addresses.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\))|(\*[^*\s][^*\n]*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;
    if (match[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2]) out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (match[3]) {
      const split = token.indexOf("](");
      out.push(
        <a key={key} href={token.slice(split + 2, -1)} target="_blank" rel="noopener noreferrer">
          {inline(token.slice(1, split), key)}
        </a>,
      );
    } else if (match[4]) out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    else
      out.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      );
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines of a paragraph, keeping the line breaks the writer put in. */
function lines(block: string[], key: string): ReactNode[] {
  return block.flatMap((line, i) => (i === 0 ? inline(line, `${key}-${i}`) : [<br key={`${key}-br${i}`} />, ...inline(line, `${key}-${i}`)]));
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export default function Markdown({ text }: { text: string }) {
  const source = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push(<p key={`p${blocks.length}`}>{lines(paragraph, `p${blocks.length}`)}</p>);
    paragraph = [];
  };

  for (let i = 0; i < source.length; i++) {
    const line = source[i];
    const key = `b${blocks.length}`;

    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < source.length && !source[i].trimStart().startsWith("```"); i++) code.push(source[i]);
      blocks.push(<pre key={key}>{code.join("\n")}</pre>);
    } else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flush();
      blocks.push(<hr key={key} />);
    } else if (/^#{1,6}\s+/.test(line)) {
      flush();
      const level = line.match(/^#+/)![0].length;
      const content = inline(line.replace(/^#{1,6}\s+/, ""), key);
      blocks.push(level <= 2 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>);
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const ordered = NUMBERED.test(line);
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[][] = [];
      for (; i < source.length; i++) {
        if (marker.test(source[i])) items.push([source[i].replace(marker, "")]);
        // An indented line continues the item above it.
        else if (/^\s{2,}\S/.test(source[i]) && items.length > 0) items[items.length - 1].push(source[i].trim());
        else break;
      }
      i--;
      const list = items.map((item, n) => <li key={n}>{lines(item, `${key}-${n}`)}</li>);
      blocks.push(ordered ? <ol key={key}>{list}</ol> : <ul key={key}>{list}</ul>);
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return <div className="markdown">{blocks}</div>;
}
