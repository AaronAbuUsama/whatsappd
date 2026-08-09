import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Account-shaped literals that are intentionally synthetic test data.
 *
 * Keep these values visible as single literals. Adding a fixture here is the
 * honest exception path for the source leak scan; splitting a value so the
 * scanner cannot see it is always an error.
 */
export const KNOWN_SYNTHETIC_ACCOUNT_FIXTURES: ReadonlySet<string> = new Set([
  "1234567890@s.whatsapp.net",
  "1234567890:1@s.whatsapp.net",
  "123456789012@s.whatsapp.net",
  "15551230000@s.whatsapp.net",
  "15551230000:7@s.whatsapp.net",
  "15551234567@s.whatsapp.net",
  "15551234567:1@s.whatsapp.net",
  "15551234567:12@s.whatsapp.net",
  "100000000000000@lid",
  "99887766@lid",
  "120363042384062365@g.us",
]);

const ACCOUNT_SHAPED = /(?:\d{7,}(?::\d+)?@s\.whatsapp\.net|\d{7,}@lid|\d{7,}(?:-\d{7,})?@g\.us)/gu;

export interface AccountFixtureFinding {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly value: string;
}

export interface AccountFixtureScan {
  readonly splitAccountLiterals: AccountFixtureFinding[];
  readonly unallowlistedAccountLiterals: AccountFixtureFinding[];
}

function accountValues(value: string): string[] {
  return [...value.matchAll(ACCOUNT_SHAPED)].map(([match]) => match);
}

function foldedString(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return foldedString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldedString(node.left);
    const right = foldedString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = foldedString(span.expression);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
}

function isStringComposition(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ((ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateExpression(node))
  );
}

function finding(
  sourceFile: ts.SourceFile,
  sourcePath: string,
  node: ts.Node,
  value: string,
): AccountFixtureFinding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    path: sourcePath,
    line: position.line + 1,
    column: position.character + 1,
    value,
  };
}

export function scanAccountFixtureSource(sourcePath: string, source: string): AccountFixtureScan {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const splitAccountLiterals: AccountFixtureFinding[] = [];
  const unallowlistedAccountLiterals: AccountFixtureFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const value of accountValues(node.text)) {
        if (!KNOWN_SYNTHETIC_ACCOUNT_FIXTURES.has(value)) {
          unallowlistedAccountLiterals.push(finding(sourceFile, sourcePath, node, value));
        }
      }
    }

    const composed =
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateExpression(node);
    if (composed && !isStringComposition(node.parent)) {
      const value = foldedString(node);
      if (value !== undefined) {
        for (const account of accountValues(value)) {
          splitAccountLiterals.push(finding(sourceFile, sourcePath, node, account));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { splitAccountLiterals, unallowlistedAccountLiterals };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [absolute] : [];
  });
}

export function scanAccountFixtureTree(directory: string): AccountFixtureScan {
  const scan: AccountFixtureScan = {
    splitAccountLiterals: [],
    unallowlistedAccountLiterals: [],
  };
  for (const file of sourceFiles(directory).sort()) {
    const result = scanAccountFixtureSource(
      path.relative(path.dirname(directory), file),
      readFileSync(file, "utf8"),
    );
    scan.splitAccountLiterals.push(...result.splitAccountLiterals);
    scan.unallowlistedAccountLiterals.push(...result.unallowlistedAccountLiterals);
  }
  return scan;
}
