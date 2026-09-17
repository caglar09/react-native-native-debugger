module.exports = {
  // Unknown versions are skipped by default. Prefer explicit support to risky source mutation.
  allowUntestedVersions: false,
  strict: false,
  progressThrottleMs: 500,
  integrations: {
    rnfs: { enabled: true },
    blobUtil: { enabled: true },
    backgroundDownloader: { enabled: true }
  }
};
