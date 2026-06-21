import type { GoogleOpenApiOAuthAudience } from "./google-presets";
import { compactGoogleOAuthScopes } from "./google-oauth-scopes";

export type GoogleOAuthBatchInput = {
  readonly id: string;
  readonly name: string;
  readonly oauthAudience: GoogleOpenApiOAuthAudience;
  readonly scopes: readonly string[];
};

export type GoogleOAuthConsentBatch = {
  readonly id: string;
  readonly label: string;
  readonly apiScopes: readonly string[];
};

const GOOGLE_CLOUD_BATCH_IDS = new Set(["google-bigquery", "google-cloud-resource-manager"]);
const GOOGLE_PHOTOS_BATCH_IDS = new Set(["google-photos-library", "google-photos-picker"]);

export const googleOAuthConsentBatches = (
  items: readonly GoogleOAuthBatchInput[],
): readonly GoogleOAuthConsentBatch[] => {
  const standardScopes: string[] = [];
  const cloudScopes: string[] = [];
  const photosScopes: string[] = [];
  const batches: GoogleOAuthConsentBatch[] = [];

  for (const item of items) {
    if (item.scopes.length === 0) continue;
    if (item.oauthAudience === "standard-user") {
      standardScopes.push(...item.scopes);
      continue;
    }
    if (GOOGLE_CLOUD_BATCH_IDS.has(item.id)) {
      cloudScopes.push(...item.scopes);
      continue;
    }
    if (GOOGLE_PHOTOS_BATCH_IDS.has(item.id)) {
      photosScopes.push(...item.scopes);
      continue;
    }
    batches.push({
      id: item.id,
      label: item.name,
      apiScopes: item.scopes,
    });
  }

  const compactedStandardScopes = compactGoogleOAuthScopes(standardScopes);
  const compactedCloudScopes = compactGoogleOAuthScopes(cloudScopes);
  const compactedPhotosScopes = compactGoogleOAuthScopes(photosScopes);
  return [
    ...(compactedStandardScopes.length > 0
      ? [
          {
            id: "google-core",
            label: "Core Google services",
            apiScopes: compactedStandardScopes,
          },
        ]
      : []),
    ...(compactedPhotosScopes.length > 0
      ? [
          {
            id: "google-photos",
            label: "Google Photos",
            apiScopes: compactedPhotosScopes,
          },
        ]
      : []),
    ...batches.map((batch) => ({
      ...batch,
      apiScopes: compactGoogleOAuthScopes(batch.apiScopes),
    })),
    ...(compactedCloudScopes.length > 0
      ? [
          {
            id: "google-cloud",
            label: "Google Cloud services",
            apiScopes: compactedCloudScopes,
          },
        ]
      : []),
  ].filter((batch) => batch.apiScopes.length > 0);
};
