# @executor-js/plugin-google

Connect Google APIs through Google Discovery documents and shared OAuth consent.

## Google Photos preset

The native Google Photos preset exposes albums, media items, selected picker media, and raw media
upload. Arbitrary pre-existing or shared albums usually cannot be managed unless Google exposes them
to this app and OAuth scope.

Uploads use the Google Photos two-step flow. First call `photoslibrary.mediaItems.upload` with raw
media bytes:

```ts
const uploadToken = await executor.tools.invoke(
  "google_photos.org.localgooglephotos.photoslibrary.mediaItems.upload",
  {
    "X-Goog-Upload-File-Name": "photo.jpg",
    "X-Goog-Upload-Protocol": "raw",
    "X-Goog-Upload-Content-Type": "image/jpeg",
    bodyBase64: jpegBase64,
  },
);
```

Then pass the returned token to `photoslibrary.mediaItems.batchCreate`. The JSON request must be
nested under `body`:

```ts
await executor.tools.invoke(
  "google_photos.org.localgooglephotos.photoslibrary.mediaItems.batchCreate",
  {
    body: {
      albumId,
      newMediaItems: [
        {
          description: "Uploaded from Executor",
          simpleMediaItem: {
            fileName: "photo.jpg",
            uploadToken,
          },
        },
      ],
    },
  },
);
```
