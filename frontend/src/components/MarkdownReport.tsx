import React from "react";

type Props = {
  text: string;
};

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

const stripCodeFence = (value: string) => {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (!match) return normalized;
  return match[1].trim();
};

const splitTableCells = (line: string) => {
  const raw = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return raw.split("|").map((cell) => cell.trim());
};

const isTableSeparator = (line: string) => /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);

const renderInline = (text: string, keyPrefix: string) => {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-b-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={`${keyPrefix}-t-${index}`}>{part}</React.Fragment>;
  });
};

const parseBlocks = (source: string) => {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: Math.min(6, heading[1].length) as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(splitTableCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^(\-|\*|•)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\-|\*|•)\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^(\-|\*|•)\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const paragraphLines = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i].trim())) {
      if (/^(\-|\*|•)\s+/.test(lines[i].trim())) break;
      if (lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      paragraphLines.push(lines[i].trim());
      i += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
};

const headingClassName = (level: number) => {
  if (level === 1) return "markdown-h1";
  if (level === 2) return "markdown-h2";
  if (level === 3) return "markdown-h3";
  if (level === 4) return "markdown-h4";
  if (level === 5) return "markdown-h5";
  return "markdown-h6";
};

const renderBlock = (block: Block, key: string) => {
  if (block.type === "heading") {
    const className = headingClassName(block.level);
    if (block.level === 1) return <h1 className={className} key={key}>{renderInline(block.text, key)}</h1>;
    if (block.level === 2) return <h2 className={className} key={key}>{renderInline(block.text, key)}</h2>;
    if (block.level === 3) return <h3 className={className} key={key}>{renderInline(block.text, key)}</h3>;
    if (block.level === 4) return <h4 className={className} key={key}>{renderInline(block.text, key)}</h4>;
    if (block.level === 5) return <h5 className={className} key={key}>{renderInline(block.text, key)}</h5>;
    return <h6 className={className} key={key}>{renderInline(block.text, key)}</h6>;
  }

  if (block.type === "list") {
    return (
      <ul className="markdown-list" key={key}>
        {block.items.map((item, index) => (
          <li key={`${key}-${index}`}>{renderInline(item, `${key}-${index}`)}</li>
        ))}
      </ul>
    );
  }

  if (block.type === "table") {
    return (
      <table className="markdown-table" key={key}>
        <thead>
          <tr>
            {block.headers.map((header, index) => (
              <th key={`${key}-th-${index}`}>{renderInline(header, `${key}-th-${index}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${key}-row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${key}-td-${rowIndex}-${cellIndex}`}>{renderInline(cell, `${key}-td-${rowIndex}-${cellIndex}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return <p key={key}>{renderInline(block.text, key)}</p>;
};

export default function MarkdownReport({ text }: Props) {
  const source = stripCodeFence(text || "");
  if (!source) return <p className="muted">No insight data.</p>;

  const blocks = parseBlocks(source);
  const sections: { title: string; body: Block[] }[] = [];
  const leadBlocks: Block[] = [];
  let activeSection: { title: string; body: Block[] } | null = null;

  blocks.forEach((block) => {
    if (block.type === "heading" && block.level === 3) {
      activeSection = { title: block.text, body: [] };
      sections.push(activeSection);
      return;
    }

    if (activeSection) {
      activeSection.body.push(block);
      return;
    }

    leadBlocks.push(block);
  });

  return (
    <div className="markdown-report">
      {leadBlocks.map((block, index) => renderBlock(block, `lead-${index}`))}
      {sections.map((section, sectionIndex) => (
        <section key={`section-${sectionIndex}`} className="wellness-section">
          <h3 className="wellness-section-title">{renderInline(section.title, `section-title-${sectionIndex}`)}</h3>
          <div className="wellness-section-body">
            {section.body.map((block, blockIndex) => renderBlock(block, `section-${sectionIndex}-${blockIndex}`))}
          </div>
        </section>
      ))}
    </div>
  );
}
