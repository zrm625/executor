import { expect, it } from "@effect/vitest";
import { googleToolkitBundles } from "./google-bundles";

it("selects exact read operations and excludes send, modify, delete and permission writes", () => {
  const names = [
    "gmail.users.messages.list",
    "gmail.users.messages.get",
    "gmail.users.messages.send",
    "gmail.users.messages.modify",
    "gmail.users.messages.delete",
    "drive.files.list",
    "drive.files.export",
    "drive.files.delete",
    "drive.permissions.create",
  ];
  const bundles = googleToolkitBundles(
    names.map((name) => ({ name, pattern: `service.org.account.${name}` })),
  );
  expect(bundles.map((bundle) => [bundle.name, bundle.patterns])).toEqual([
    [
      "Email read-only",
      [
        "service.org.account.gmail.users.messages.get",
        "service.org.account.gmail.users.messages.list",
      ],
    ],
    [
      "Drive read-only",
      ["service.org.account.drive.files.export", "service.org.account.drive.files.list"],
    ],
  ]);
});

it("includes picker session management but excludes Library uploads", () => {
  const names = [
    "photospicker.sessions.create",
    "photospicker.sessions.delete",
    "photospicker.mediaItems.list",
    "photoslibrary.mediaItems.batchCreate",
    "photoslibrary.uploads.upload",
  ];
  const bundles = googleToolkitBundles(
    names.map((name) => ({ name, pattern: `photos.org.main.${name}` })),
  );
  expect(bundles.map((bundle) => bundle.patterns)).toEqual([
    [
      "photos.org.main.photospicker.mediaItems.list",
      "photos.org.main.photospicker.sessions.create",
      "photos.org.main.photospicker.sessions.delete",
    ],
  ]);
});

it("deduplicates current addresses without widening account or operation selection", () => {
  const tools = [
    { name: "gmail.users.messages.list", pattern: "gmail.user.mine.gmail.users.messages.list" },
  ];
  expect(googleToolkitBundles([...tools, ...tools])[0]?.patterns).toEqual([tools[0].pattern]);
  expect(googleToolkitBundles([])).toEqual([]);
});
