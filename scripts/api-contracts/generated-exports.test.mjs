import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GENERATED_API_FILES = [
  "lib/api-client-react/src/generated/api.ts",
  "lib/api-zod/src/generated/api.ts",
];

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  const names = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

function exportedDeclarations(source, fileName = "generated.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = [];
  const add = (name, kind, implementation = false, node) => {
    declarations.push({
      name,
      kind,
      implementation,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          add(element.name.text, "re-export", false, element);
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        add(statement.exportClause.name.text, "re-export", false, statement.exportClause);
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement)) {
      const name = isDefault ? "default" : statement.name?.text;
      if (name) add(name, "function", statement.body !== undefined, statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          add(name, "variable", false, declaration);
        }
      }
      continue;
    }

    const namedDeclarations = [
      [ts.isClassDeclaration, "class"],
      [ts.isInterfaceDeclaration, "interface"],
      [ts.isTypeAliasDeclaration, "type"],
      [ts.isEnumDeclaration, "enum"],
      [ts.isModuleDeclaration, "namespace"],
    ];
    const match = namedDeclarations.find(([isType]) => isType(statement));
    if (match) {
      const name = isDefault ? "default" : statement.name?.text;
      if (name) add(name, match[1], false, statement);
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      add("default", "default", false, statement);
    }
  }
  return declarations;
}

function conflictingExports(declarations) {
  const byName = new Map();
  for (const declaration of declarations) {
    const locations = byName.get(declaration.name) ?? [];
    locations.push(declaration);
    byName.set(declaration.name, locations);
  }

  return [...byName]
    .filter(([, entries]) => {
      if (entries.length < 2) return false;
      if (entries.every((entry) => entry.kind === "function")) {
        return entries.filter((entry) => entry.implementation).length > 1;
      }
      return true;
    })
    .map(([name, entries]) => ({
      name,
      lines: entries.map((entry) => entry.line),
    }));
}

test("valid exported function overloads with one implementation are allowed", () => {
  const declarations = exportedDeclarations(`
    export function parse(value: string): string;
    export function parse(value: number): number;
    export function parse(value: string | number): string | number { return value; }
  `);
  assert.deepEqual(conflictingExports(declarations), []);
});

test("multiple exported function implementations are rejected", () => {
  const declarations = exportedDeclarations(`
    export function parse(value: string): string { return value; }
    export function parse(value: number): number { return value; }
  `);
  assert.deepEqual(conflictingExports(declarations), [
    { name: "parse", lines: [2, 3] },
  ]);
});

test("duplicate exported declarations and re-exports are rejected", () => {
  const declarations = exportedDeclarations(`
    export const duplicateValue = 1;
    export const duplicateValue = 2;
    export interface DuplicateShape {}
    export interface DuplicateShape {}
    export type DuplicateAlias = string;
    export type DuplicateAlias = number;
    export class DuplicateClass {}
    export class DuplicateClass {}
    const source = 1;
    export { source as duplicateAlias };
    export { source as duplicateAlias };
  `);
  assert.deepEqual(
    conflictingExports(declarations).map(({ name }) => name),
    ["duplicateValue", "DuplicateShape", "DuplicateAlias", "DuplicateClass", "duplicateAlias"],
  );
});

test("generated API modules do not redeclare exported symbols", async () => {
  for (const relativePath of GENERATED_API_FILES) {
    const source = await readFile(path.join(ROOT, relativePath), "utf8");
    const declarations = exportedDeclarations(source);
    assert.ok(declarations.length > 0, relativePath + " contains no exported declarations");
    const duplicates = conflictingExports(declarations);
    assert.deepEqual(
      duplicates,
      [],
      relativePath + " contains duplicate generated exports",
    );
  }
});
