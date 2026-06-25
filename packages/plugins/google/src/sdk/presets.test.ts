import { expect, it } from "@effect/vitest";

import {
  GOOGLE_PHOTOS_PRESET_ID,
  googleOpenApiPresets,
  googlePhotosOpenApiBundlePreset,
  googlePhotosOpenApiPresets,
  googlePhotosPresetIds,
  googleStandardUserOAuthPresets,
} from "./presets";

it("keeps Select all limited to Google services that can use normal user OAuth", () => {
  const standardIds = new Set(googleStandardUserOAuthPresets.map((preset) => preset.id));

  expect(standardIds).toContain("google-calendar");
  expect(standardIds).toContain("google-gmail");
  expect(standardIds).toContain("google-tasks");
  expect(standardIds).toContain("google-people");
  expect(standardIds).toContain("google-search-console");

  expect(standardIds).not.toContain("google-youtube-data");
  expect(standardIds).not.toContain("google-cloud-resource-manager");
  expect(standardIds).not.toContain("google-chat");
  expect(standardIds).not.toContain("google-keep");
  expect(standardIds).not.toContain("google-admin-directory");
  expect(standardIds).not.toContain("google-admin-reports");
});

it("keeps Google Photos as a dedicated native preset", () => {
  expect(googlePhotosOpenApiBundlePreset).toMatchObject({
    id: GOOGLE_PHOTOS_PRESET_ID,
    name: "Google Photos",
  });
  expect(googlePhotosPresetIds).toEqual(["google-photos-library", "google-photos-picker"]);
  expect(googlePhotosOpenApiPresets.map((preset) => preset.oauthAudience)).toEqual([
    "limited-user",
    "limited-user",
  ]);
  expect(googleOpenApiPresets.map((preset) => preset.id)).not.toContain("google-photos-library");
  expect(googleOpenApiPresets.map((preset) => preset.id)).not.toContain("google-photos-picker");
});

it("classifies every Google service for bundle OAuth UX", () => {
  expect(
    googleOpenApiPresets.map((preset) => ({
      id: preset.id,
      oauthAudience: preset.oauthAudience,
    })),
  ).toMatchSnapshot();
});
