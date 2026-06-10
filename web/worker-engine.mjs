process.env.VIDEO_STUDIO_ROLE = process.env.VIDEO_STUDIO_ROLE || "worker";
await import("./server.mjs");
