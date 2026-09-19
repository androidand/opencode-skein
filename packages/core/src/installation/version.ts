declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
// The only channels a real published release ever carries. Anything else —
// "local", "dev", or a one-off OPENCODE_CHANNEL override — is a build that
// was never uploaded anywhere, so comparing its version against the latest
// published release is meaningless and self-upgrading over it is actively
// harmful (it silently replaces a binary someone is deliberately running for
// its own changes, mid-session, with unrelated published code).
export const InstallationReleaseChannels = ["latest", "beta", "prod"]
export const InstallationIsRelease = InstallationReleaseChannels.includes(InstallationChannel)
