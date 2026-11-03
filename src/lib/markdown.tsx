/**
 * Small, safe Markdown renderer for analyst answers.
 *
 * Produces React elements only (never raw HTML), so model output cannot inject markup.
 * Supports: headings, paragraphs, bold/italic, inline code, fenced code, links (http/https
 * only), ordered/unordered lists (one nesting level), block quotes, horizontal rules and
 * simple pipe tables. `renderText` / `renderCode` let callers turn plain-text spans or code
 * spans into richer nodes (e.g. clickable component-id chips).
 */
import { Fragment, type ReactNode } from "react";

export interface MarkdownOptions {
  /** Render a run of plain text (default: the string itself). */
  renderText?: (text: string, key: string) => ReactNode;
  /** Render an inline code span; return null to use the default <code>. */
  renderCode?: (code: string, key: string) => ReactNode | null;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\s\n][^*\n]*?\*)|((?<![\w])_[^_\s\n][^_\n]*?_(?![\w]))|(\[[^\]\n]+\]\([^)\s]+\))/;

function renderInline(text: string, opts: MarkdownOptions, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  const plain = (s: string) => {
    if (!s) return;
    const k = `${keyBase}-t${i++}`;
    out.push(opts.renderText ? <Fragment key={k}>{opts.renderText(s, k)}</Fragment> : <Fragment key={k}>{s}</Fragment>);
  };
  while (rest.length) {
    const m = INLINE.exec(rest);
    if (!m) {
      plain(rest);
      break;
    }
    plain(rest.slice(0, m.index));
    const tok = m[0];
    const k = `${keyBase}-i${i++}`;
    if (m[1]) {
      const code = tok.slice(1, -1);
      const custom = opts.renderCode?.(code, k);
      out.push(
        custom ?? (
          <code key={k} className="rounded bg-white/[0.07] px-1 py-[1px] font-mono text-[0.88em] text-ink-50">
            {code}
          </code>
        ),
      );
    } else if (m[2] || m[3]) {
      out.push(
        <strong key={k} className="font-semibold text-ink-50">
          {renderInline(tok.slice(2, -2), opts, k)}
        </strong>,
      );
    } else if (m[4] || m[5]) {
      out.push(
        <em key={k} className="text-ink-100 italic">
          {renderInline(tok.slice(1, -1), opts, k)}
        </em>,
      );
    } else if (m[6]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? "";
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a
            key={k}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-200 underline decoration-sky-200/30 underline-offset-2 hover:text-sky-100"
          >
            {label}
          </a>,
        );
      } else {
        out.push(<Fragment key={k}>{renderInline(label, opts, k)}</Fragment>);
      }
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): ReactNode {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  const key = () => `b${b++}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre
          key={key()}
          className="dt-scroll my-2 overflow-x-auto rounded-md border border-white/[0.06] bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-ink-100"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const k = key();
      const level = h[1].length;
      const cls =
        level <= 2
          ? "mt-3 mb-1 font-display text-[13.5px] font-semibold text-ink-50"
          : "mt-2.5 mb-1 font-mono text-[10.5px] tracking-[0.12em] text-ink-200 uppercase";
      blocks.push(
        level <= 2 ? (
          <h3 key={k} className={cls}>
            {renderInline(h[2], opts, k)}
          </h3>
        ) : (
          <h4 key={k} className={cls}>
            {renderInline(h[2], opts, k)}
          </h4>
        ),
      );
      i++;
      continue;
    }
    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key()} className="my-2.5 border-white/[0.08]" />);
      i++;
      continue;
    }
    // table
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const k = key();
      blocks.push(
        <div key={k} className="dt-scroll my-2 overflow-x-auto rounded-md border border-white/[0.07]">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr className="bg-white/[0.03]">
                {header.map((c, ci) => (
                  <th
                    key={ci}
                    className="border-b border-white/[0.07] px-2 py-1 text-left font-mono text-[9.5px] font-medium tracking-[0.1em] text-ink-300 uppercase"
                  >
                    {renderInline(c, opts, `${k}h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-white/[0.04] last:border-0">
                  {header.map((_, ci) => (
                    <td key={ci} className="dt-num px-2 py-1 align-top text-ink-100">
                      {renderInline(r[ci] ?? "", opts, `${k}r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // list
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; nested: boolean }[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (m) {
          items.push({ text: m[3], nested: m[1].length >= 2 });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      const k = key();
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag
          key={k}
          className={
            ordered
              ? "my-1.5 list-decimal space-y-1 pl-5 marker:font-mono marker:text-[10.5px] marker:text-ink-400"
              : "my-1.5 list-disc space-y-1 pl-4 marker:text-ink-500"
          }
        >
          {items.map((it, ii) => (
            <li key={ii} className={it.nested ? "ml-4 list-[circle]" : undefined}>
              {renderInline(it.text, opts, `${k}-${ii}`)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    // blockquote
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      const k = key();
      blocks.push(
        <blockquote key={k} className="my-2 border-l-2 border-white/15 pl-2.5 text-ink-300">
          {renderInline(body.join(" "), opts, k)}
        </blockquote>,
      );
      continue;
    }
    // paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    )
      para.push(lines[i++].trim());
    if (!para.length) para.push(lines[i++].trim()); // safety: always make progress
    const k = key();
    blocks.push(
      <p key={k} className="my-1.5">
        {renderInline(para.join(" "), opts, k)}
      </p>,
    );
  }
  return <>{blocks}</>;
}
