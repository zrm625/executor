import { expect, it } from "@effect/vitest";

import { openApiPresets } from "./presets";
import {
  GOOGLE_BUNDLE_PRESET_ID,
  GOOGLE_PHOTOS_PRESET_ID,
  googleOpenApiPresets,
  googlePhotosOpenApiPresets,
  googlePhotosPresetIds,
  googleStandardUserOAuthPresets,
} from "./google-presets";

it("keeps Select all limited to Google services that can use normal user OAuth", () => {
  const standardIds = new Set(googleStandardUserOAuthPresets.map((preset) => preset.id));

  expect(standardIds).toContain("google-calendar");
  expect(standardIds).toContain("google-gmail");
  expect(standardIds).toContain("google-tasks");
  expect(standardIds).toContain("google-people");
  expect(standardIds).toContain("google-search-console");

  expect(standardIds).not.toContain("google-photos-library");
  expect(standardIds).not.toContain("google-photos-picker");
  expect(standardIds).not.toContain("google-youtube-data");
  expect(standardIds).not.toContain("google-cloud-resource-manager");
  expect(standardIds).not.toContain("google-chat");
  expect(standardIds).not.toContain("google-keep");
  expect(standardIds).not.toContain("google-admin-directory");
  expect(standardIds).not.toContain("google-admin-reports");
});

it("exposes Google Photos as one native preset", () => {
  expect(openApiPresets.find((preset) => preset.id === GOOGLE_PHOTOS_PRESET_ID)).toMatchObject({
    name: "Google Photos",
  });
  expect(openApiPresets[0]?.id).toBe(GOOGLE_BUNDLE_PRESET_ID);
  expect(openApiPresets[1]?.id).toBe(GOOGLE_PHOTOS_PRESET_ID);

  const googleApiPresetIds = new Set(googleOpenApiPresets.map((preset) => preset.id));
  const googlePhotosApiPresetIds = new Set(googlePhotosOpenApiPresets.map((preset) => preset.id));
  expect(googlePhotosPresetIds).toEqual(["google-photos-library", "google-photos-picker"]);
  for (const presetId of googlePhotosPresetIds) {
    expect(googleApiPresetIds.has(presetId)).toBe(false);
    expect(googlePhotosApiPresetIds.has(presetId)).toBe(true);
  }
});

it("classifies every Google service for bundle OAuth UX", () => {
  expect(
    googleOpenApiPresets.map((preset) => ({
      id: preset.id,
      oauthAudience: preset.oauthAudience,
    })),
  ).toMatchSnapshot();
});
