// Tiny, safe renderer for model text: paragraphs, bullet lists, **bold** and
// pipe tables. Produces React elements only — no HTML injection.
import type { ReactNode } from "react";

function links(text: string, keyBase: string): ReactNode[] {
  // Only http(s) URLs become links; they open in a new tab without referrer access.
  return text.split(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={`${keyBase}-u${i}`} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    ) : (
      part
    ),
  );
}

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, i): ReactNode[] =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      [<strong key={`${keyBase}-${i}`}>{links(part.slice(2, -2), `${keyBase}-${i}`)}</strong>]
    ) : (
      links(part, `${keyBase}-${i}`)
    ),
  );
}

const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export default function MessageText({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (!/^\s*\|?[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(lines[i])) rows.push(cells(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="ffc-table-wrap" key={`t${i}`}>
          <table>
            {head && (
              <thead>
                <tr>{head.map((c, j) => <th key={j} scope="col">{inline(c, `h${j}`)}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `c${ri}${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+\.)\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`l${i}`}>{items.map((it, j) => <li key={j}>{inline(it, `li${j}`)}</li>)}</List>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("|") && !/^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i].replace(/^#+\s*/, ""));
      i++;
    }
    blocks.push(<p key={`p${i}`}>{inline(para.join(" "), `p${i}`)}</p>);
  }
  return <>{blocks}</>;
}
