import React from 'react';

export function MessageBody({ body, onOpenPage }: { body: string; onOpenPage: (id: string) => void }) {
  const token = /\[\[page:([a-f0-9-]{36})\|([^\]]+)\]\]/gi;
  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of body.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) content.push(<React.Fragment key={`text-${cursor}`}>{body.slice(cursor, index)}</React.Fragment>);
    let title = match[2];
    try { title = decodeURIComponent(match[2]); } catch { /* Preserve malformed display text safely. */ }
    content.push(<button key={`page-${match[1]}`} className="message-page-link" onClick={() => onOpenPage(match[1])}>{title} ↗</button>);
    cursor = index + match[0].length;
  }
  if (cursor < body.length) content.push(<React.Fragment key={`text-${cursor}`}>{body.slice(cursor)}</React.Fragment>);
  return <p className="message-body">{content}</p>;
}
