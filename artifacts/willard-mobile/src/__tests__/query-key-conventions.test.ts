import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "../../app");
const generatedApi = readFileSync(
  resolve(import.meta.dirname, "../../../../lib/api-client-react/src/generated/api.ts"),
  "utf8",
);

function readAppFile(relativePath: string): string {
  return readFileSync(resolve(appRoot, relativePath), "utf8");
}

test("generated mobile query helpers keep the canonical API prefixes", () => {
  assert.match(generatedApi, /getGetSettingsQueryKey[\s\S]*?`\/api\/settings`/);
  assert.match(generatedApi, /getListOpenaiConversationsQueryKey[\s\S]*?`\/api\/openai\/conversations`/);
  assert.match(generatedApi, /getListOpenaiMessagesQueryKey[\s\S]*?`\/api\/openai\/conversations\/\$\{id\}\/messages`/);
  assert.match(generatedApi, /getGetCollectionsQueryKey[\s\S]*?`\/api\/collections`/);
  assert.match(generatedApi, /getGetCollectionsIdItemsQueryKey[\s\S]*?`\/api\/collections\/\$\{id\}\/items`/);
  assert.match(generatedApi, /getGetMediaFilesQueryKey[\s\S]*?`\/api\/media\/files`/);
});

test("mobile screens use generated keys for reads and mutation refreshes", () => {
  const settings = readAppFile("(tabs)/settings.tsx");
  const chat = readAppFile("(tabs)/chat.tsx");
  const collections = readAppFile("collections.tsx");
  const collectionDetail = readAppFile("collection/[id].tsx");
  const library = readAppFile("(tabs)/library.tsx");

  assert.match(settings, /getGetSettingsQueryKey/);
  assert.match(chat, /getListOpenaiConversationsQueryKey/);
  assert.match(chat, /getListOpenaiMessagesQueryKey/);
  assert.match(chat, /getGetOpenaiConversationQueryKey/);
  assert.match(collections, /getGetCollectionsQueryKey/);
  assert.match(collectionDetail, /getGetCollectionsIdItemsQueryKey/);
  assert.match(collectionDetail, /getGetMediaFilesQueryKey/);
  assert.match(library, /getListFolderQueryKey/);
  assert.match(library, /getSearchFilesQueryKey/);

  for (const source of [settings, chat, collections, collectionDetail, library]) {
    assert.doesNotMatch(source, /queryKey:\s*\[/);
    assert.doesNotMatch(source, /mobile-(?:collections|collection-items)|library-(?:folder|search)/);
  }
});